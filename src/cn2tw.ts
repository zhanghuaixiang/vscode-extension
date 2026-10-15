import * as vscode from "vscode";
import { performance } from "node:perf_hooks";

const opencc = require("opencc-js");

// 中日韩统一表意文字（含扩展 A 与兼容表意文字）
const CJK_TEST = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/;
const CJK_REPLACE = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]+/g;

export default class Cn2Tw {
    static dictType: { [key: string]: string } = {
        "hk": "hk",
        "tw": "twp",
        "traditional": "tw"
    };
    static init(subscriptions: vscode.Disposable[]) {
        Cn2Tw.updateContext();
        // 配置变化时同步菜单/命令面板的可用状态
        subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('Converter.ctEnable')) {
                Cn2Tw.updateContext();
            }
        }));
        subscriptions.push(
            vscode.commands.registerCommand('opencc.cn2tw', () => Cn2Tw.convert('cn', Cn2Tw.getTargetDict())),
            vscode.commands.registerCommand('opencc.tw2cn', () => Cn2Tw.convert(Cn2Tw.getTargetDict(), 'cn'))
        );
    }
    /**
     * 简繁转换是否启用（默认关闭）
     */
    private static isEnabled(): boolean {
        return vscode.workspace.getConfiguration().get<boolean>('Converter.ctEnable') === true;
    }
    /**
     * 同步 condition.showCn2Tw 上下文，控制右键菜单与命令面板的展示
     */
    private static updateContext() {
        vscode.commands.executeCommand("setContext", "condition.showCn2Tw", Cn2Tw.isEnabled());
    }
    /**
     * 读取用户配置的繁体类型，未配置或取值非法时回退到 tw
     */
    private static getTargetDict(): string {
        const type = vscode.workspace.getConfiguration().get<string>('Converter.ctType');
        return Cn2Tw.dictType[type || ""] || Cn2Tw.dictType["tw"];
    }
    private static convert(from: string, to: string) {
        if (!Cn2Tw.isEnabled()) {
            vscode.window.showInformationMessage("简繁体转换功能未启用，请在设置中开启 Converter.ctEnable");
            return;
        }
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        const document = editor.document;
        // 无选区时转换整篇文档
        const ranges = editor.selection.isEmpty
            ? [new vscode.Range(document.lineAt(0).range.start, document.lineAt(document.lineCount - 1).range.end)]
            : editor.selections.slice();
        Cn2Tw.translateRange(editor, ranges, from, to);
    }
    static async translateRange(editor: vscode.TextEditor, ranges: vscode.Range[], from: string, to: string) {
        await vscode.window.withProgress({
            title: '简繁字体转换中...',
            location: vscode.ProgressLocation.Notification,
            cancellable: true
        }, async (_progress, token) => {
            const converter = opencc.Converter({ from: from, to: to });
            for (const range of ranges) {
                if (token.isCancellationRequested) {
                    break;
                }
                // 让出事件循环，避免长任务阻塞 UI
                await new Promise(resolve => setTimeout(resolve));
                const text = editor.document.getText(range);
                const segments = text.split(/\b/g);
                let lastReport = 0;
                let cancelled = false;
                for (let i = 0; i < segments.length; i++) {
                    const now = performance.now();
                    if ((now - lastReport) > 100) {
                        lastReport = now;
                        if (token.isCancellationRequested) {
                            cancelled = true;
                            break;
                        }
                        await new Promise(resolve => setTimeout(resolve));
                    }
                    if (CJK_TEST.test(segments[i])) {
                        segments[i] = segments[i].replace(CJK_REPLACE, (s: string) => converter(s));
                    }
                }
                // 取消时不再写入，避免用部分转换结果覆盖原文
                if (cancelled) {
                    break;
                }
                const result = segments.join('');
                if (result === text) {
                    continue;
                }
                const applied = await editor.edit(builder => builder.replace(range, result));
                if (!applied) {
                    vscode.window.showErrorMessage('简繁字体转换失败：文档在转换过程中被修改，请重试');
                    break;
                }
            }
        });
    }
}
