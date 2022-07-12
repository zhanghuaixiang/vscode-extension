// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import LeftMenus from "./leftMenus";
import ReadI18n from "./readI18n";
const path = require("path");
const fs = require("fs");

const rootPath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
const packagePath = path.join(vscode.workspace.rootPath || rootPath, "package.json");

// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	let packageJSON = fs.readFileSync(packagePath, "utf8");
	LeftMenus.init();
	ReadI18n.init(packageJSON);
	// 监听package.json改变，改变后重新初始化指令
	fs.watch(packagePath, ()=>{
		// 先注销之前的指令，然后重新初始化
		LeftMenus.commands.forEach(command => {
			command.dispose();
		});
		LeftMenus.init();
	});
	
}

// this method is called when your extension is deactivated
export function deactivate() {
	vscode.commands.registerCommand("startup", () => {
		vscode.window.showWarningMessage("rapid tools插件未启用");
	});
}
