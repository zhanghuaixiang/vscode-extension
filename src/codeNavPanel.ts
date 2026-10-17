import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { analyze } from './codeNavCore';
import { PAGE_SIZE, projectResult, sectionIds, sectionPage, templatePage } from './codeNavProjection';
import { AnalysisCancelled, AnalysisTask, runAnalysis } from './codeNavRunner';
import { CodeNavResult, SourceRange } from './codeNavTypes';

type PanelStatus = 'unsupported' | 'loading' | 'ready' | 'error';

interface Snapshot {
    uri: string;
    version: number;
    fingerprint: string;
    result: CodeNavResult;
    durationMs: number;
}

export class CodeNavPanel implements vscode.WebviewViewProvider {
    static readonly viewId = 'rapidTools.codeNav';

    private view?: vscode.WebviewView;
    private editor?: vscode.TextEditor;
    private snapshot?: Snapshot;
    private status: PanelStatus = 'unsupported';
    private message = '打开 .vue 或 .js 文件开始阅读';
    private rendererReady = false;
    private renderedFile?: string;
    private refreshCount = 0;
    private readonly cache = new Map<string, Snapshot>();
    private running?: AnalysisTask;
    private requestId = 0;
    private publicationId = 0;
    private workerRuns = 0;
    private cacheHits = 0;
    private mode: 'file' | 'function' = 'file';
    private focusId?: string;
    private focusMessage = '';

    constructor(private readonly context: vscode.ExtensionContext) {
        context.subscriptions.push(vscode.window.registerWebviewViewProvider(CodeNavPanel.viewId, this));
        context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => this.setEditor(editor)));
        context.subscriptions.push({ dispose: () => this.running?.cancel() });
        context.subscriptions.push(vscode.commands.registerCommand('rapidTools.codeNav.refresh', () => this.refresh()));
        context.subscriptions.push(vscode.commands.registerCommand(
            'rapidTools.codeNav.focusFunction', () => this.focusFunction()
        ));
        context.subscriptions.push(vscode.commands.registerCommand(
            'rapidTools.codeNav.showFile', () => this.showFile()
        ));
        context.subscriptions.push(vscode.commands.registerCommand('rapidTools.codeNav.debugPage',
            (key: string, offset: number) => this.snapshot && ({
                total: sectionIds(this.snapshot.result, key)?.length,
                nodes: sectionPage(this.snapshot.result, key, offset)
            })));
        context.subscriptions.push(vscode.commands.registerCommand('rapidTools.codeNav.revealNode',
            (id: string, relationIndex?: number) => this.revealNode(id, relationIndex)));
        context.subscriptions.push(vscode.commands.registerCommand('rapidTools.codeNav.debugState', () => ({
            status: this.status,
            uri: this.editor?.document.uri.toString(),
            version: this.snapshot?.version,
            renderedFile: this.renderedFile,
            rendererReady: this.rendererReady,
            refreshCount: this.refreshCount,
            workerRuns: this.workerRuns,
            cacheHits: this.cacheHits,
            nodeCount: this.snapshot?.result.nodes.length,
            mode: this.mode,
            focusName: this.snapshot?.result.nodes.find(node => node.id === this.focusId)?.name,
            focusMessage: this.focusMessage,
            entryNames: this.snapshot?.result.guide.entries.map(id =>
                this.snapshot?.result.nodes.find(node => node.id === id)?.name),
            nodes: this.snapshot?.result.nodes.slice(0, 1000)
                .map(node => ({ id: node.id, name: node.name, line: node.range.startLine }))
        })));
        context.subscriptions.push(vscode.commands.registerCommand(
            'rapidTools.codeNav.analyze',
            (source: string, fileName: string): CodeNavResult => analyze(source, fileName)
        ));
        this.setEditor(vscode.window.activeTextEditor);
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
        view.webview.options = { enableScripts: true, localResourceRoots: [media] };
        const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'code-nav.css'));
        const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'code-nav.js'));
        const nonce = crypto.randomBytes(16).toString('hex');
        view.webview.html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${css}">
  <title>代码理解</title>
</head>
<body>
  <div id="app" aria-live="polite"></div>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
        this.context.subscriptions.push(view.webview.onDidReceiveMessage(message => {
            if (!message || typeof message.type !== 'string') { return; }
            switch (message.type) {
                case 'ready':
                    this.rendererReady = true;
                    this.publish();
                    break;
                case 'applied':
                    if (message.publicationId === this.publicationId) {
                        this.renderedFile = typeof message.file === 'string' ? message.file : undefined;
                    }
                    break;
                case 'refresh':
                    this.refresh();
                    break;
                case 'focus':
                    this.focusFunction();
                    break;
                case 'showFile':
                    this.showFile();
                    break;
                case 'reveal':
                    if (typeof message.id === 'string') {
                        void this.revealNode(message.id,
                            Number.isInteger(message.relationIndex) ? message.relationIndex : undefined);
                    }
                    break;
                case 'pageSection':
                    if (message.publicationId === this.publicationId
                        && typeof message.key === 'string' && Number.isInteger(message.offset)
                        && this.snapshot && this.status === 'ready') {
                        const ids = sectionIds(this.snapshot.result, message.key);
                        const nodes = sectionPage(this.snapshot.result, message.key, message.offset);
                        if (ids && nodes) {
                            void view.webview.postMessage({
                                type: 'sectionPage', publicationId: this.publicationId,
                                key: message.key, offset: message.offset, total: ids.length,
                                ids: ids.slice(message.offset, message.offset + PAGE_SIZE), nodes
                            });
                        }
                    }
                    break;
                case 'pageTemplate':
                    if (message.publicationId === this.publicationId
                        && (typeof message.parentId === 'string' || message.parentId === null)
                        && Number.isInteger(message.offset) && this.snapshot && this.status === 'ready') {
                        const page = templatePage(this.snapshot.result, message.parentId, message.offset);
                        if (page) {
                            void view.webview.postMessage({
                                type: 'templatePage', publicationId: this.publicationId,
                                parentId: message.parentId, offset: message.offset, ...page
                            });
                        }
                    }
                    break;
            }
        }));
        this.publish();
    }

    private setEditor(editor?: vscode.TextEditor): void {
        this.requestId++;
        this.running?.cancel();
        this.running = undefined;
        this.editor = editor;
        this.snapshot = undefined;
        this.renderedFile = undefined;
        this.mode = 'file';
        this.focusId = undefined;
        this.focusMessage = '';
        if (!editor || !/\.(vue|js)$/i.test(editor.document.fileName)) {
            this.status = 'unsupported';
            this.message = '打开 .vue 或 .js 文件开始阅读';
            this.publish();
            return;
        }
        this.analyzeEditor(false);
    }

    private refresh(): void {
        this.refreshCount++;
        this.focusId = undefined;
        this.analyzeEditor(true);
    }

    private showFile(): void {
        this.mode = 'file';
        this.focusMessage = '';
        this.publish();
    }

    private focusFunction(): void {
        const document = this.editor?.document;
        const result = this.snapshot?.result;
        if (!document || !result || document.version !== this.snapshot?.version) {
            this.focusMessage = '当前文件正在分析或已修改，请刷新后重试';
            this.publish();
            return;
        }
        const cursor = this.editor!.selection.active;
        const functions = result.nodes.filter(node =>
            ['function', 'method', 'classMethod', 'hook', 'computed', 'watch'].includes(node.kind)
            && node.range.startLine - 1 <= cursor.line
            && node.range.endLine - 1 >= cursor.line
            && (node.range.startLine - 1 !== cursor.line || node.range.startColumn - 1 <= cursor.character)
            && (node.range.endLine - 1 !== cursor.line || node.range.endColumn - 1 >= cursor.character));
        functions.sort((a, b) =>
            (a.range.endLine - a.range.startLine) - (b.range.endLine - b.range.startLine));
        if (!functions.length) {
            this.focusMessage = '请先把编辑器光标放在一个函数或方法内';
            this.publish();
            return;
        }
        this.focusId = functions[0].id;
        this.focusMessage = '';
        this.mode = 'function';
        this.publish();
    }

    private analyzeEditor(force: boolean): void {
        const request = ++this.requestId;
        this.running?.cancel();
        this.running = undefined;
        const document = this.editor?.document;
        if (!document || !/\.(vue|js)$/i.test(document.fileName)) {
            this.status = 'unsupported';
            this.message = '当前文件类型暂不支持';
            this.snapshot = undefined;
            this.publish();
            return;
        }
        const uri = document.uri.toString();
        const version = document.version;
        const source = document.getText();
        const fingerprint = crypto.createHash('sha256').update(source).digest('hex');
        const cached = this.cache.get(uri);
        if (!force && cached?.fingerprint === fingerprint) {
            this.cache.delete(uri);
            this.snapshot = { ...cached, version };
            this.cache.set(uri, this.snapshot);
            this.cacheHits++;
            this.status = 'ready';
            this.message = '';
            this.publish();
            return;
        }
        this.snapshot = undefined;
        this.status = 'loading';
        this.message = '正在分析当前文件';
        this.publish();
        this.workerRuns++;
        const start = performance.now();
        const task = runAnalysis(this.context.extensionPath, source, document.fileName);
        this.running = task;
        void task.promise.then(result => {
            if (request !== this.requestId || this.editor?.document.uri.toString() !== uri) { return; }
            if (this.editor.document.version !== version) {
                this.status = 'error';
                this.message = '文件在分析期间发生变化，请刷新或切换回来更新';
                this.publish();
                return;
            }
            this.snapshot = {
                uri, version, fingerprint, result, durationMs: Math.round(performance.now() - start)
            };
            // Keep one huge snapshot and a few smaller recent files, without accumulating huge results.
            if (result.nodes.length > 50_000) { this.cache.clear(); }
            this.cache.delete(uri);
            this.cache.set(uri, this.snapshot);
            while (this.cache.size > 3) { this.cache.delete(this.cache.keys().next().value!); }
            this.status = 'ready';
            this.message = '';
            this.publish();
        }, error => {
            if (error instanceof AnalysisCancelled || request !== this.requestId) { return; }
            this.snapshot = undefined;
            this.status = 'error';
            this.message = error instanceof Error ? error.message : String(error);
            this.publish();
        }).finally(() => {
            if (this.running === task) { this.running = undefined; }
        });
    }

    private publish(): void {
        if (!this.view || !this.rendererReady) { return; }
        const publicationId = ++this.publicationId;
        void this.view.webview.postMessage({
            type: 'state',
            publicationId,
            status: this.status,
            message: this.message,
            file: this.editor?.document.uri.toString(),
            name: this.editor?.document.fileName,
            version: this.snapshot?.version,
            durationMs: this.snapshot?.durationMs,
            mode: this.mode,
            focusId: this.focusId,
            focusMessage: this.focusMessage,
            result: this.status === 'ready' && this.snapshot
                ? projectResult(this.snapshot.result, this.focusId) : undefined
        });
    }

    private async revealNode(id: string, relationIndex?: number): Promise<void> {
        const snapshot = this.snapshot;
        const document = this.editor?.document;
        if (!snapshot || !document || document.uri.toString() !== snapshot.uri
            || document.version !== snapshot.version) {
            this.refresh();
            return;
        }
        const node = snapshot.result.nodes.find(item => item.id === id);
        if (!node) { return; }
        let range: SourceRange = node.range;
        if (relationIndex !== undefined) {
            const relation = snapshot.result.paths[relationIndex];
            if (!relation || relation.from !== id) { return; }
            range = relation.evidence;
        }
        if (range.startLine < 1 || range.startLine > document.lineCount) { return; }
        const position = new vscode.Position(range.startLine - 1,
            Math.min(range.startColumn - 1, document.lineAt(range.startLine - 1).text.length));
        const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
}

export function registerCodeNavPanel(context: vscode.ExtensionContext): void {
    new CodeNavPanel(context);
}
