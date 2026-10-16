import * as vscode from "vscode";

// 大模型对话接口的请求/响应结构（OpenAI 兼容格式）
interface ChatMessage {
    role: string;
    content: string;
}

interface ChatCompletion {
    choices?: { message?: ChatMessage }[];
}

// 请求超时（毫秒），避免网络异常时命令长时间无响应
const REQUEST_TIMEOUT = 60_000;

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
        const config = vscode.workspace.getConfiguration();
        if (!config.get('Converter.enUrl')) {
            vscode.window.showErrorMessage("请先在设置中配置enUrl");
            return false;
        }
        if (!config.get('Converter.AIModel')) {
            vscode.window.showErrorMessage("请先在设置中配置AIModel");
            return false;
        }
        if (!config.get('Converter.enLabel')) {
            vscode.window.showErrorMessage("请先在设置中配置enLabel");
            return false;
        }
        return true;
    }

    static async postQuestion(text?: string): Promise<string> {
        const config = vscode.workspace.getConfiguration();
        const url = config.get<string>('Converter.enUrl');
        const model = config.get<string>('Converter.AIModel');
        const label = config.get<string>('Converter.enLabel');
        const requestData = {
            model,
            messages: [
                {
                    role: "user",
                    content: "翻译：" + (text || label)
                }
            ]
        };
        try {
            // 使用扩展宿主内置的 fetch（Node 18+），避免引入会访问全局 navigator 的第三方 HTTP 库
            const response = await fetch(<string>url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(requestData),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT)
            });
            if (!response.ok) {
                const detail = await response.text().catch(() => "");
                vscode.window.showErrorMessage(`enConverter 接口错误: ${response.status} ${response.statusText}${detail ? " " + detail : ""}`);
                return "";
            }
            const data = <ChatCompletion>await response.json();
            const content: string = data?.choices?.[0]?.message?.content ?? "";
            return ENConverter.stripFences(content.trim());
        } catch (error) {
            const timedOut = error instanceof Error && error.name === "TimeoutError";
            vscode.window.showErrorMessage(timedOut
                ? `enConverter 请求超时（${REQUEST_TIMEOUT / 1000}s），请检查网络或接口可用性`
                : "enConverter 网络错误，请检查 enUrl 配置或网络连通性");
            return "";
        }
    }

    // 剥离模型输出可能包裹的 markdown 代码围栏
    private static stripFences(content: string): string {
        const fence = content.match(/^```[\w-]*\r?\n([\s\S]*?)\r?\n?```$/);
        return fence ? fence[1].trim() : content;
    }
}
