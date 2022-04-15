/**
 * author: 张怀祥
 * desc: 左侧菜单栏 
 */

import * as vscode from 'vscode';
const fs = require("fs");
const path = require("path");

export default class LeftMenus {
	// private static activatedTerminals
	// 菜单--启动
    static startup():void {
		const rootPath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
		const packagePath = path.join(vscode.workspace.rootPath || rootPath, "package.json");
		if(fs.existsSync(packagePath)) {
			const packageJSON = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
			const { scripts, rapidMenus } = packageJSON;
			if(rapidMenus && rapidMenus.startup) {
				const scs = rapidMenus.startup.split("&&");
				scs.forEach((s: string) => {
					const name = s.trim();
					LeftMenus.createTerminalAndExec(name, scripts);
				});
			}
		} else {
			vscode.window.showErrorMessage("根目录下未找到package.json");
		}
    }

	// 创建终端并
	static createTerminalAndExec(name:string, scripts:{[key:string]: string}):void {
		if(!scripts || !scripts[name]) {
			vscode.window.showErrorMessage(`package.json中未配置${name}指令`);
			return;
		}
		let shell = vscode.window.createTerminal(name);
		console.log(shell);
		shell.show(true);
		shell.sendText(`npm run ${name}`);
		vscode.window.showInformationMessage(`${name}正在执行...`);
	}

	static shutdownTask() {
		vscode.window.showInputBox({placeHolder:"请输入要中止的任务名称"}).then(result => {
			vscode.window.terminals.filter(item => {
				if(item.name === result) {
					console.log(vscode.window.activeTerminal);
				}
			});
			// console.log("222", vscode.window.activeTerminal);
		});
	}
}