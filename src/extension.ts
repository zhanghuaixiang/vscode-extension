// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import LeftMenus from "./leftMenus";

// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	LeftMenus.showCommand().then(()=>{
		vscode.commands.executeCommand("setContext", "condition.showRapidMenu", true);
		// 启动服务
		vscode.commands.registerCommand("startup", LeftMenus.startup);
		// 终止终端指令
		vscode.commands.registerCommand("shutdown.task", LeftMenus.shutdownTask);
	});
}

// this method is called when your extension is deactivated
export function deactivate() {
	vscode.commands.registerCommand("startup", () => {
		vscode.window.showWarningMessage("rapid tools插件未启用");
	});
}
