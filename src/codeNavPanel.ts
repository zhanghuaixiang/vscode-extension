import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { AiInsightCache, chat } from './aiClient';
import { AI_SETTINGS_QUERY, AI_SETTING_KEYS, readAiSettings } from './aiConfig';
import { AI_SYSTEM_PROMPT, AiInsight, AiScope, buildContext, insightCacheKey, isKnownLine, parseInsight, scopeKey } from './codeNavAi';
import { analyze } from './codeNavCore';
import { CrossRefResult, findImporters, findSymbolSites } from './codeNavCrossRef';
import { ContractCheckResult, verifyContract } from './codeNavContract';
import { GitTrace, traceRange } from './codeNavGit';
import { PAGE_SIZE, matchNodes, projectResult, sectionIds, sectionPage, templatePage } from './codeNavProjection';
import { AnalysisCancelled, AnalysisTask, runAnalysis } from './codeNavRunner';
import { CodeNavResult, SourceRange } from './codeNavTypes';

type PanelStatus = 'unsupported' | 'loading' | 'ready' | 'error';

/** 面板内检索的结果条数上限：命中再多也只回这么多，避免一次消息体过大。 */
const SEARCH_LIMIT = 60;

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
    private message = '打开 .vue、.js 或 .ts 文件开始阅读';
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
    private messageListener?: vscode.Disposable;
    private readonly aiCache = new AiInsightCache();
    private readonly aiPending = new Map<string, AbortController>();
    private crossRef?: AbortController;
    private readonly crossPending = new Set<string>();
    /** 每次切换文件或重新分析都自增，用于丢弃上一份文件的跨文件检索结果。 */
    private crossRefToken = 0;
    /** 最近一次跨文件结果里出现过的文件，只有这些文件允许被面板打开。 */
    private crossRefFiles = new Set<string>();
    private gitTrace?: AbortController;
    private readonly gitTracePending = new Set<string>();
    /** 与 crossRefToken 同理：文件一变，在途的 blame 结果作废。 */
    private gitTraceToken = 0;
    private contract?: AbortController;
    private contractPending = false;
    private contractToken = 0;

    constructor(private readonly context: vscode.ExtensionContext) {
        context.subscriptions.push(vscode.window.registerWebviewViewProvider(CodeNavPanel.viewId, this));
        context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => this.setEditor(editor)));
        context.subscriptions.push({ dispose: () => this.running?.cancel() });
        context.subscriptions.push({ dispose: () => { this.cancelAi(); this.crossRef?.abort(); this.gitTrace?.abort(); this.contract?.abort(); this.messageListener?.dispose(); } });
        // AI 配置变化后立即刷新面板：用户在设置页改完不必重启窗口。
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
            if (!AI_SETTING_KEYS.some(key => event.affectsConfiguration(key))) { return; }
            this.cancelAi();
            this.publish();
        }));
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
        // 视图隐藏后再次显示时本方法会被重新调用，旧监听必须释放，否则订阅只增不减。
        this.messageListener?.dispose();
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
        this.messageListener = view.webview.onDidReceiveMessage(message => {
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
                case 'revealLine':
                    if (Number.isInteger(message.line)) { void this.revealLine(message.line); }
                    break;
                case 'revealAiLine':
                    if (Number.isInteger(message.line)) { void this.revealAiLine(message.line); }
                    break;
                case 'aiInsight':
                    if (typeof message.scope === 'string') {
                        void this.requestInsight(message.scope, message.force === true);
                    }
                    break;
                case 'configure':
                    void vscode.commands.executeCommand('workbench.action.openSettings', AI_SETTINGS_QUERY);
                    break;
                case 'crossRef':
                    if (typeof message.value === 'string'
                        && (message.kind === 'importers' || message.kind === 'symbol')) {
                        void this.runCrossRef(message.kind, message.value,
                            typeof message.id === 'string' ? message.id : undefined);
                    }
                    break;
                case 'openLocation':
                    if (typeof message.file === 'string' && Number.isInteger(message.line)) {
                        void this.openLocation(message.file, message.line);
                    }
                    break;
                case 'gitTrace':
                    if (typeof message.id === 'string') { void this.runGitTrace(message.id); }
                    break;
                case 'contractCheck':
                    void this.runContractCheck();
                    break;
                case 'filter':
                    if (typeof message.text === 'string') { this.searchNodes(message.text); }
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
        });
        this.publish();
    }

    private setEditor(editor?: vscode.TextEditor): void {
        this.requestId++;
        this.running?.cancel();
        this.running = undefined;
        this.cancelAi();
        this.cancelCrossRef();
        this.cancelGitTrace();
        this.cancelContractCheck();
        this.crossRefFiles.clear();
        this.editor = editor;
        this.snapshot = undefined;
        this.renderedFile = undefined;
        this.mode = 'file';
        this.focusId = undefined;
        this.focusMessage = '';
        if (!editor || !/\.(vue|js|ts)$/i.test(editor.document.fileName)) {
            this.status = 'unsupported';
            this.message = '打开 .vue、.js 或 .ts 文件开始阅读';
            this.publish();
            return;
        }
        this.analyzeEditor(false);
    }

    private refresh(): void {
        this.refreshCount++;
        this.mode = 'file';
        this.focusId = undefined;
        this.focusMessage = '';
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
        this.cancelAi();
        this.cancelCrossRef();
        this.cancelGitTrace();
        this.cancelContractCheck();
        const document = this.editor?.document;
        if (!document || !/\.(vue|js|ts)$/i.test(document.fileName)) {
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
        const settings = readAiSettings();
        void this.view.webview.postMessage({
            type: 'state',
            publicationId,
            status: this.status,
            message: this.message,
            file: this.editor?.document.uri.toString(),
            name: this.editor?.document.fileName,
            version: this.snapshot?.version,
            snapshotId: this.snapshot?.fingerprint,
            durationMs: this.snapshot?.durationMs,
            mode: this.mode,
            focusId: this.focusId,
            focusMessage: this.focusMessage,
            ai: { enabled: settings.enabled, issue: settings.issue, model: settings.gateway.model },
            result: this.status === 'ready' && this.snapshot
                ? projectResult(this.snapshot.result, this.focusId) : undefined
        });
    }

    /** 切换文件或重新分析时作废所有在途 AI 请求，避免旧回答落到新文件上。 */
    private cancelAi(): void {
        for (const controller of this.aiPending.values()) { controller.abort(); }
        this.aiPending.clear();
    }

    /**
     * 切换文件或重新分析时作废在途的跨文件检索，并让旧结果无法再写回面板。
     * 检索本身在 git 子进程 / 文件读取里执行，中断后不再占用内存与 IO。
     */
    private cancelCrossRef(): void {
        this.crossRefToken++;
        this.crossRef?.abort();
        this.crossRef = undefined;
        // 主动取消也要回一条终态，否则面板上的按钮会一直停在「正在检索」。
        for (const value of this.crossPending) { this.replyCrossRef(value, 'cancelled'); }
        this.crossPending.clear();
    }

    /**
     * 跨文件检索：全部按需触发，不建立常驻索引，结果有上限且可被下一次操作中断。
     * 「谁引用了我」限定在当前文件；「跨文件调用点」只接受本次分析结果里已有的节点名，
     * 避免面板变成任意符号的全库搜索入口。
     */
    private async runCrossRef(kind: 'importers' | 'symbol', value: string, id?: string): Promise<void> {
        const document = this.editor?.document;
        const snapshot = this.snapshot;
        if (!document || !snapshot || document.uri.toString() !== snapshot.uri
            || document.uri.scheme !== 'file') {
            this.replyCrossRef(value, 'error', undefined, '当前文件正在分析或已修改，请刷新后重试。');
            return;
        }
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder) {
            this.replyCrossRef(value, 'error', undefined, '请先打开一个工作区文件夹，跨文件检索只在工作区内进行。');
            return;
        }
        let symbol = '';
        if (kind === 'symbol') {
            const node = snapshot.result.nodes.find(item => item.id === id);
            if (!node || !node.name) {
                this.replyCrossRef(value, 'error', undefined, '该节点已不在当前分析结果中，请刷新后重试。');
                return;
            }
            symbol = node.name;
        }
        this.crossRef?.abort();
        const controller = new AbortController();
        this.crossRef = controller;
        const token = this.crossRefToken;
        this.crossPending.add(value);
        try {
            const root = folder.uri.fsPath;
            const result = kind === 'importers'
                ? await findImporters({ root, target: document.uri.fsPath, signal: controller.signal })
                : await findSymbolSites({
                    root, symbol, excludeFile: document.uri.fsPath, signal: controller.signal
                });
            if (token !== this.crossRefToken) { return; }
            // 只累积，不覆盖：面板上可能同时留着多次检索的结果，这些文件都允许被点开。
            for (const row of result.importers) { this.crossRefFiles.add(row.absolute); }
            for (const row of result.hits) { this.crossRefFiles.add(row.absolute); }
            this.replyCrossRef(value, 'ready', result);
        } catch (error) {
            if (token !== this.crossRefToken) { return; }
            this.replyCrossRef(value, 'error', undefined,
                error instanceof Error ? error.message : String(error));
        } finally {
            if (this.crossRef === controller) {
                this.crossRef = undefined;
                this.crossPending.delete(value);
            }
        }
    }

    private replyCrossRef(
        value: string, state: 'ready' | 'error' | 'cancelled', result?: CrossRefResult, message?: string
    ): void {
        if (!this.view) { return; }
        void this.view.webview.postMessage({ type: 'crossRef', value, state, result, message });
    }

    /** 打开跨文件检索结果里的某个位置；只允许打开本次结果中确实出现过的文件。 */
    private async openLocation(file: string, line: number): Promise<void> {
        if (!this.crossRefFiles.has(file)) { return; }
        const uri = vscode.Uri.file(file);
        const document = await vscode.workspace.openTextDocument(uri);
        if (line < 1 || line > document.lineCount) { return; }
        const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
        const position = new vscode.Position(line - 1, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    /** 切换文件或重新分析时作废在途的 blame；主动取消同样回一条终态，避免按钮卡在加载中。 */
    private cancelGitTrace(): void {
        this.gitTraceToken++;
        this.gitTrace?.abort();
        this.gitTrace = undefined;
        for (const id of this.gitTracePending) { this.replyGitTrace(id, 'cancelled'); }
        this.gitTracePending.clear();
    }

    /**
     * 函数级 Git 溯源：只对这一个函数的行区间做 blame，不做全库 blame、不留缓存。
     * 非 git 仓库 / 未装 git 都返回 unavailable 而非报错，面板直接不展示这一块。
     */
    private async runGitTrace(id: string): Promise<void> {
        const document = this.editor?.document;
        const snapshot = this.snapshot;
        if (!document || !snapshot || document.uri.toString() !== snapshot.uri
            || document.uri.scheme !== 'file') {
            this.replyGitTrace(id, 'error', undefined, '当前文件正在分析或已修改，请刷新后重试。');
            return;
        }
        const node = snapshot.result.nodes.find(item => item.id === id);
        if (!node || node.range.endLine < node.range.startLine) {
            this.replyGitTrace(id, 'error', undefined, '该节点已不在当前分析结果中，请刷新后重试。');
            return;
        }
        this.gitTrace?.abort();
        const controller = new AbortController();
        this.gitTrace = controller;
        const token = this.gitTraceToken;
        this.gitTracePending.add(id);
        try {
            const outcome = await traceRange({
                file: document.uri.fsPath,
                startLine: node.range.startLine,
                endLine: node.range.endLine,
                signal: controller.signal
            });
            if (token !== this.gitTraceToken) { return; }
            if (outcome.state === 'unavailable') {
                this.replyGitTrace(id, 'unavailable', undefined, outcome.reason);
            } else {
                // 编辑器里有未保存改动时，blame 读到的是磁盘内容，行号可能与面板不一致。
                const trace = { ...outcome.trace, unsaved: document.isDirty };
                this.replyGitTrace(id, 'ready', trace);
            }
        } catch (error) {
            if (token !== this.gitTraceToken) { return; }
            this.replyGitTrace(id, 'error', undefined,
                error instanceof Error ? error.message : String(error));
        } finally {
            if (this.gitTrace === controller) {
                this.gitTrace = undefined;
                this.gitTracePending.delete(id);
            }
        }
    }

    private replyGitTrace(
        id: string, state: 'ready' | 'unavailable' | 'error' | 'cancelled',
        trace?: GitTrace, message?: string
    ): void {
        if (!this.view) { return; }
        void this.view.webview.postMessage({ type: 'gitTrace', id, state, trace, message });
    }

    /** 切换文件或重新分析时作废在途的契约校验；主动取消回一条终态，避免按钮停在加载中。 */
    private cancelContractCheck(): void {
        this.contractToken++;
        this.contract?.abort();
        this.contract = undefined;
        if (this.contractPending) {
            this.contractPending = false;
            this.replyContractCheck('cancelled');
        }
    }

    /**
     * 组件契约校验：用本文件声明的 props / emits，核对「确定引用本文件」的父组件模板。
     * 只回答模板里写了什么，不做运行时推断；父组件数量与结论条数都有上限。
     */
    private async runContractCheck(): Promise<void> {
        const document = this.editor?.document;
        const snapshot = this.snapshot;
        if (!document || !snapshot || document.uri.toString() !== snapshot.uri
            || document.uri.scheme !== 'file') {
            this.replyContractCheck('error', undefined, '当前文件正在分析或已修改，请刷新后重试。');
            return;
        }
        if (!/\.vue$/i.test(document.fileName)) {
            this.replyContractCheck('unavailable', undefined, '契约校验只针对 .vue 组件，需要本文件的 props / emits 声明。');
            return;
        }
        const contract = snapshot.result.contract;
        if (!contract || (!contract.props.length && !contract.emits.length)) {
            this.replyContractCheck('unavailable', undefined, '本文件没有声明 props 或 emits，没有可核对的契约。');
            return;
        }
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder) {
            this.replyContractCheck('error', undefined, '请先打开一个工作区文件夹，契约校验只在工作区内进行。');
            return;
        }
        this.contract?.abort();
        const controller = new AbortController();
        this.contract = controller;
        const token = this.contractToken;
        this.contractPending = true;
        try {
            const result = await verifyContract({
                root: folder.uri.fsPath,
                target: document.uri.fsPath,
                props: contract.props.map(item => ({ name: item.name, required: item.required })),
                // 只拿已声明的事件当契约：父组件监听了本文件触发但未声明的事件不算问题。
                emits: contract.emits.filter(item => item.declared).map(item => item.name),
                signal: controller.signal
            });
            if (token !== this.contractToken) { return; }
            // 结论里的父组件文件允许被点开，与跨文件检索共用同一份白名单。
            for (const report of result.reports) { this.crossRefFiles.add(report.absolute); }
            this.replyContractCheck('ready', result);
        } catch (error) {
            if (token !== this.contractToken) { return; }
            this.replyContractCheck('error', undefined,
                error instanceof Error ? error.message : String(error));
        } finally {
            if (this.contract === controller) {
                this.contract = undefined;
                this.contractPending = false;
            }
        }
    }

    private replyContractCheck(
        state: 'ready' | 'unavailable' | 'error' | 'cancelled',
        result?: ContractCheckResult, message?: string
    ): void {
        if (!this.view) { return; }
        void this.view.webview.postMessage({ type: 'contractCheck', state, result, message });
    }

    /**
     * 面板内符号检索：直接扫内存里的完整分析结果（不是只发了首页的那部分），
     * 不落盘、不调外部命令，命中按「完全同名 → 前缀 → 包含」排序后截断。
     */
    private searchNodes(text: string): void {
        const snapshot = this.snapshot;
        if (!this.view || !snapshot || this.status !== 'ready') { return; }
        const found = matchNodes(snapshot.result.nodes, text, SEARCH_LIMIT);
        void this.view.webview.postMessage({
            type: 'filter',
            text,
            snapshotId: snapshot.fingerprint,
            total: found.total,
            matches: found.matches
        });
    }

    /**
     * 面板内 AI 解读：未启用或网关未配置时**不发任何请求**，只回一条配置提示。
     * 结果按缓存键去重，文件改变后旧结果自然失效（缓存键含文件文本）。
     */
    private async requestInsight(scope: string, force: boolean): Promise<void> {
        const snapshot = this.snapshot;
        const document = this.editor?.document;
        if (!snapshot || !document || document.uri.toString() !== snapshot.uri
            || document.version !== snapshot.version) {
            // 文件已改动：重新分析并让面板按新的 snapshotId 清空旧解读。
            this.refresh();
            return;
        }
        const snapshotId = snapshot.fingerprint;
        const target: AiScope = scope === 'file' ? { kind: 'file' } : { kind: 'node', id: scope };
        const settings = readAiSettings();
        if (!settings.enabled || settings.issue) {
            this.replyInsight(snapshotId, scope, 'error', undefined, settings.issue || '未启用 AI 解读');
            return;
        }
        const source = document.getText();
        const key = insightCacheKey(source, target, settings.gateway.model);
        const cached = force ? undefined : this.aiCache.get(key);
        if (cached) { this.replyInsight(snapshotId, scope, 'ready', cached); return; }
        if (this.aiPending.has(key)) { return; }
        const controller = new AbortController();
        this.aiPending.set(key, controller);
        try {
            const outcome = await chat({
                config: settings.gateway,
                messages: [
                    { role: 'system', content: AI_SYSTEM_PROMPT },
                    { role: 'user', content: buildContext(snapshot.result, source, target) }
                ],
                signal: controller.signal
            });
            if (!outcome.ok) {
                if (outcome.failure === 'aborted') {
                    // 主动取消（改配置）也要回一条 cancelled，否则前端 pending 状态会永久残留。
                    this.replyInsight(snapshotId, scope, 'cancelled');
                } else {
                    this.replyInsight(snapshotId, scope, 'error', undefined, outcome.message);
                }
                return;
            }
            const insight = parseInsight(outcome.text, snapshot.result, settings.gateway.model, scopeKey(target));
            this.aiCache.set(key, insight);
            this.replyInsight(snapshotId, scope, 'ready', insight);
        } finally {
            this.aiPending.delete(key);
        }
    }

    /** 回传 AI 结果；文件快照已经变化时直接丢弃，避免把旧内容接到新文件上。 */
    private replyInsight(
        snapshotId: string, scope: string, state: 'ready' | 'error' | 'cancelled',
        insight?: AiInsight, message?: string
    ): void {
        if (!this.view || this.snapshot?.fingerprint !== snapshotId) { return; }
        void this.view.webview.postMessage({
            type: 'aiInsight',
            snapshotId,
            scope,
            state,
            text: insight?.text,
            evidence: insight?.evidence,
            dropped: insight?.dropped,
            model: insight?.model,
            message
        });
    }

    /** AI 引用行跳转：只允许跳到本文件节点覆盖过的行，与行号校验共用白名单。 */
    private async revealAiLine(line: number): Promise<void> {
        const snapshot = this.snapshot;
        const document = this.editor?.document;
        if (!snapshot || !document || document.uri.toString() !== snapshot.uri
            || document.version !== snapshot.version) {
            this.refresh();
            return;
        }
        if (!isKnownLine(snapshot.result, line)) { return; }
        await this.revealPosition(document, { startLine: line, startColumn: 1, endLine: line, endColumn: 1 });
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
        await this.revealPosition(document, range);
    }

    /** 只允许跳到本次分析记录过的行（作者注释、契约与状态流转），避免面板成为任意行跳转入口。 */
    private async revealLine(line: number): Promise<void> {
        const snapshot = this.snapshot;
        const document = this.editor?.document;
        if (!snapshot || !document || document.uri.toString() !== snapshot.uri
            || document.version !== snapshot.version) {
            this.refresh();
            return;
        }
        const contract = snapshot.result.contract;
        const known = snapshot.result.doc?.line === line
            || snapshot.result.comments.some(item => item.line === line)
            || contract.slots.some(item => item.line === line)
            || contract.injections.some(item => item.line === line)
            || contract.flows.some(flow => flow.templateLines.includes(line));
        if (!known) { return; }
        await this.revealPosition(document, { startLine: line, startColumn: 1, endLine: line, endColumn: 1 });
    }

    private async revealPosition(
        document: vscode.TextDocument, range: SourceRange
    ): Promise<void> {
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
