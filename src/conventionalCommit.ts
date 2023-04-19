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
            vscode.window.showInformationMessage("hello");
        });
    }
}