import * as vscode from 'vscode';

export default class Commit {
    static init() {
        vscode.commands.registerCommand("nihao1", ()=>{
            vscode.window.showInformationMessage("我是菜单1");
        });
        vscode.commands.registerCommand("nihao2", ()=>{
            vscode.window.showInformationMessage("我是菜单2");
        });
        Commit.registCommand();
        vscode.window.setStatusBarMessage("你好，前端艺术家");
    }
    static registCommand() {
        vscode.commands.registerCommand("gerrit.commit", ()=>{
            // vscode.window.showInformationMessage("hello");
            const quickPick = Handler.createQuickPick({
                placeholder: "",
                totalSteps: 2, 
                step: 1, 
                items: [
                    {
                        label: "feature#",
                        detail: "新需求"
                    },
                    {
                        label: "change#",
                        detail: "需求改动"
                    },
                    {
                        label: "bugfix#",
                        detail: "bug修复"
                    }
                ],
                buttons: [
                    {
                        iconPath: new vscode.ThemeIcon('arrow-right'),
				        tooltip: 'confirm'
                    }
                ]
            });

            quickPick.onDidChangeSelection((v)=>{
                quickPick.placeholder = quickPick.placeholder += v[0].label;
                quickPick.step = 2;
                quickPick.buttons = [
                    {
                        iconPath: new vscode.ThemeIcon('arrow-left'),
				        tooltip: 'back'
                    },
                    {
                        iconPath: new vscode.ThemeIcon('arrow-right'),
				        tooltip: 'confirm'
                    }
                ],
                quickPick.items = [
                    {
                        label: "EDITORA-1310",
                        detail: "告警信息太多"
                    },
                    {
                        label: "EDITORA-1311",
                        detail: "告警发起就看见信息太多"
                    },
                    {
                        label: "EDITORA-1312",
                        detail: "任务请求信息太多"
                    },
                ];
            });
        });
    }
}

class Handler {
    static createQuickPick(params:{[key:string]:any}) {
        
        let quickPick:vscode.QuickPick<vscode.QuickPickItem> = vscode.window.createQuickPick();
        quickPick.step = params.step;
        quickPick.totalSteps = params.totalSteps;
        quickPick.buttons = params.buttons;
        quickPick.items = params.items;
        quickPick.placeholder = params.placeholder;
        quickPick.show();
        return quickPick;
    }
}