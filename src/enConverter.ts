import * as vscode from "vscode";
import { readAiSettings } from "./aiConfig";
import { chat } from "./aiClient";

export default class ENConverter {
    // 记录上一次菜单展示状态，避免每次选区变化都高频调用 setContext
    private static lastShown = false;

    static init(subscriptions: vscode.Disposable[]) {
        // 控制菜单是否展示（仅在状态变化时更新）
        subscriptions.push(vscode.window.onDidChangeTextEditorSelection((e) => {
            const editor = vscode.window.activeTextEditor;
            const text = editor ? editor.document.getText(e.selections[0]) : "";
            const show = !!text;
            if (show !== ENConverter.lastShown) {
                ENConverter.lastShown = show;
                vscode.commands.executeCommand("setContext", "condition.showEnConverter", show);
            }
        }));

        // 无条件注册命令，配置校验推迟到执行时，避免命令缺失导致菜单点击报错
        subscriptions.push(vscode.commands.registerCommand('opencc.cn2en', async () => {
            if (!ENConverter.prepared()) {
                return;
            }
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return;
            }
            // 命令执行时实时读取选区，避免使用过期状态
            const range = new vscode.Range(editor.selection.start, editor.selection.end);
            const text = editor.document.getText(range);
            if (!text) {
                return;
            }
            const res = await ENConverter.postQuestion(text);
            if (!res) {
                return;
            }
            const applied = await editor.edit((editBuilder) => {
                editBuilder.replace(range, res);
            });
            if (!applied) {
                vscode.window.showErrorMessage("enConverter 写入译文失败，编辑器内容可能已变化");
            }
        }));
    }

    static prepared() {
        const issue = readAiSettings().issue;
        if (issue) {
            vscode.window.showErrorMessage(`enConverter 无法执行：${issue}`);
            return false;
        }
        if (!ENConverter.prompt()) {
            vscode.window.showErrorMessage("请先在设置中配置 Converter.enLabel");
            return false;
        }
        return true;
    }

    /** 翻译提示词，随功能本身保留在 Converter 分组下。 */
    private static prompt(): string {
        return vscode.workspace.getConfiguration().get<string>('Converter.enLabel')?.trim() ?? '';
    }

    /** 走统一 AI 通道；失败时返回空串（失败原因已通过消息提示给出）。 */
    static async postQuestion(text?: string): Promise<string> {
        const outcome = await chat({
            config: readAiSettings().gateway,
            messages: [{ role: "user", content: "翻译：" + (text || ENConverter.prompt()) }]
        });
        if (outcome.ok) {
            return outcome.text;
        }
        vscode.window.showErrorMessage(`enConverter ${outcome.message}`);
        return "";
    }
}
