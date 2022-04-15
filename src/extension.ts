// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import LeftMenus from "./leftMenus";

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	vscode.commands.registerCommand("startup", LeftMenus.startup);
}

// this method is called when your extension is deactivated
export function deactivate() {
	vscode.commands.registerCommand("start.a", () => {
		console.log("harri-tools插件未启用");
	});	
}
