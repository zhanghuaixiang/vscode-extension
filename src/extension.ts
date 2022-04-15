// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import LeftMenus from "./leftMenus";


// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	// 启动服务
	vscode.commands.registerCommand("startup", LeftMenus.startup);
	vscode.commands.registerCommand("shutdown.task", LeftMenus.shutdownTask);
}

// this method is called when your extension is deactivated
export function deactivate() {
	vscode.commands.registerCommand("startup", () => {
		console.log("harri-tools插件未启用");
	});	
}
