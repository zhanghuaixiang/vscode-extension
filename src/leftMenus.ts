/**
 * author: 张怀祥
 * desc: 左侧菜单栏 
 */
import * as vscode from 'vscode';
const fs = require("fs");
const path = require("path");

// 命令分隔符
const SPLIT_TAG = "&&";

const rootPath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
const packagePath = path.join(vscode.workspace.rootPath || rootPath, "package.json");

let utils:{[key:string]: Function} = {
	splitScripts(script:string) {
		if(!script) {
			return [];
		}
		const names = script.split(SPLIT_TAG);
		const result = names.map(name => {
			return name.trim();
		});
		return result;
	},
	
	/**
	 * 获取启动脚本
	 * 参数配置格式：
	 * 第一种：
	 * "rapidMenus": {
	 *		"startup": {
	 *			"script": "dev && test"
	 *		}
	 *	}
	 * 第二种：
	 * "rapidMenus": {
	 *		"startup": "dev && test"
	 *	}
	 * @param menuName 指令名称
	 * @param origin 
	 * @returns 脚本名称
	 */
	getScript (menuName:string, origin:{[key:string]: any}):string {
		if(!origin || !menuName) {
			return "";
		}
		if(typeof origin[menuName] === "string") {
			return origin[menuName];
		} else if (typeof origin[menuName] === "object") {
			return origin[menuName].script || "";
		}
		return "";
	}
};

export default class LeftMenus {
	static commands: Array<vscode.Disposable> = [];
	static init() {
		if(LeftMenus.showCommand()) {
			vscode.commands.executeCommand("setContext", "condition.showRapidMenu", true);
			// 启动服务
			const startup = vscode.commands.registerCommand("startup", LeftMenus.startup);
			LeftMenus.commands.push(startup);
			// 终止终端指令
			const shutdown = vscode.commands.registerCommand("shutdown.task", LeftMenus.shutdownTask);
			LeftMenus.commands.push(shutdown);
		}else{
			vscode.commands.executeCommand("setContext", "condition.showRapidMenu", false);
		}
	}
	// 判断有没有配置快捷菜单，配置后才展示菜单项
	static showCommand() {
		return !!LeftMenus.getRapidMenus();
	}

	/**
	 * 获取快捷菜单配置
	 * 优先从工作区 settings.json（VS Code 设置）读取，未配置时托底从 package.json 读取
	 */
	static getRapidMenus(): {[key:string]: any} | null {
		// 优先从 settings.json 读取
		const settingsMenus = vscode.workspace.getConfiguration().get('rapidMenus');
		if (settingsMenus) {
			return <{[key:string]: any}>settingsMenus;
		}
		// 托底：从 package.json 读取
		if (fs.existsSync(packagePath)) {
			const { rapidMenus } = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
			if (rapidMenus) {
				return rapidMenus;
			}
		}
		return null;
	}
	// 菜单--启动
    static startup():void {
		// scripts：package.json中配置的命令；rapidMenus：快捷菜单配置（settings.json 优先，托底 package.json）
		let scripts:{[key:string]: string} = {};
		if(fs.existsSync(packagePath)) {
			const packageJSON = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
			scripts = packageJSON.scripts;
		}
		const rapidMenus = LeftMenus.getRapidMenus();
		// 获取要执行的指令
		const script = utils.getScript("startup", rapidMenus);
		if(script) {
			const scriptNames = utils.splitScripts(script);
			scriptNames.forEach((name: string) => {
				LeftMenus.createTerminalAndExec(name, scripts);
			});
		} else {
			vscode.window.showErrorMessage("配置格式不符合要求");
		}
    }

	// 创建终端并执行
	static createTerminalAndExec(name:string, scripts:{[key:string]: string}):void {
		if(!scripts || !scripts[name]) {
			vscode.window.showErrorMessage(`package.json中未配置${name}指令`);
			return;
		}
		let shell = vscode.window.createTerminal(name);
		shell.show(true);
		shell.sendText(`npm run ${name}`);
		vscode.window.showInformationMessage(`终端【${name}】正在运行...`);
	}

	/**
	 * 终止终端指令
	 * @param name 要终止的指令名称
	 */
	static shutdownTask(name:string) {
		if (typeof name === "string") {
			vscode.window.terminals.forEach(item => {
				if(item.name === name) {
					item.dispose();
				}
			});
		} else {
			vscode.window.showInputBox({placeHolder:"请输入要中止的任务名称"}).then(result => {
				const names = utils.splitScripts(result);
				vscode.window.terminals.forEach(item => {
					if(names.includes(item.name)) {
						item.dispose();
					}
				});
			});
		}
	}
}
