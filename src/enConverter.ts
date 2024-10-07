import * as vscode from "vscode";
import axios from "axios";

export default class ENConverter{
    static init() {
        if(!ENConverter.prepared()) {
            return;
        }
        ENConverter.postQuestion().then(res=>{
            vscode.window.showInformationMessage("enConverter 已就绪"+res);
        });
        // 控制菜单是否展示
        vscode.window.onDidChangeTextEditorSelection((e: any) => {
            const rrr = e.selections.map((x: { start: any; end: any; }) => new vscode.Range(x.start, x.end));
            const text = vscode.window.activeTextEditor?.document.getText(rrr[0]);
            if (text) {
                vscode.commands.executeCommand("setContext", "condition.showEnConverter", true);
            } else {
                vscode.commands.executeCommand("setContext", "condition.showEnConverter", false);
            }
        });
        const panel = vscode.window.createOutputChannel("enConverter");
        // 注册命令
        vscode.commands.registerCommand('opencc.cn2en', () => {
            if(!ENConverter.prepared()) {
                return;
            }

            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const rrr = editor.selections.map((x: { start: any; end: any; }) => new vscode.Range(x.start, x.end));
                const text = editor.document.getText(rrr[0]);
                if (text) {
                    ENConverter.postQuestion(text).then((res) => {
                        vscode.window.activeTextEditor?.edit((editBuilder) => {
                            editBuilder.replace(rrr[0], <string>res);
                        });
                    });
                }
            }
        });
    }
    static prepared() {
        let url = vscode.workspace.getConfiguration().get('Converter.enUrl');
        let model = vscode.workspace.getConfiguration().get('Converter.AIModel');
        let label = vscode.workspace.getConfiguration().get('Converter.enLabel');
        if(!url) {
            vscode.window.showErrorMessage("请先在设置中配置enUrl");
            return false;
        }
        if(!model) {
            vscode.window.showErrorMessage("请先在设置中配置AIModel");
            return false;
        }
        if(!label) {
            vscode.window.showErrorMessage("请先在设置中配置enLabel");
            return false;
        }
        return true;
    }
    static postQuestion(text?:string) {
        let url = vscode.workspace.getConfiguration().get('Converter.enUrl');
        let model = vscode.workspace.getConfiguration().get('Converter.AIModel');
        let label = vscode.workspace.getConfiguration().get('Converter.enLabel');
        const requestData = {
            model,
            messages: [
                {
                    role: "user",
                    content: "翻译："+(text || label)
                }
            ]
        };
        return new Promise((resolve, reject) => {
            try {
                axios.post(<string>url, requestData, {
                    headers: {
                        "Content-Type": "application/json"
                    }
                }).then(function (response) {
                    const chatResult = response.data.choices[0].message.content;
                    resolve(chatResult.trim());
                }).catch(function (error) {
                    reject(error.response.data);
                    vscode.window.showErrorMessage(JSON.stringify(error.response.data));
                });
            } catch (error) {
                reject(error);
                vscode.window.showErrorMessage("converter程序异常，请检查enConverter");
            }
        });
        
    }
}