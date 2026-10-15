/**
 * author: 张怀祥
 * desc: 左侧菜单栏 
 */
import * as vscode from 'vscode';
import utils from './utils/utils';

// 命令分隔符
const SPLIT_TAG = "&&";

let menuUtils: { [key: string]: Function } = {
	splitScripts(script: string) {
		if (!script) {
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
	getScript(menuName: string, origin: { [key: string]: any }): string {
		if (!origin || !menuName) {
			return "";
		}
		if (typeof origin[menuName] === "string") {
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
		// 支持重复调用（配置变化后重新初始化），先释放上一次的命令
		LeftMenus.disposeAll();
		if (LeftMenus.showCommand()) {
			vscode.commands.executeCommand("setContext", "condition.showRapidMenu", true);
			// 启动服务
			LeftMenus.commands.push(vscode.commands.registerCommand("startup", LeftMenus.startup));
		} else {
			vscode.commands.executeCommand("setContext", "condition.showRapidMenu", false);
		}
	}
	/**
	 * 注销全部命令并清空数组，避免重复初始化时数组无限增长
	 */
	static disposeAll() {
		LeftMenus.commands.forEach(command => command.dispose());
		LeftMenus.commands = [];
	}
	// 判断有没有配置快捷菜单，配置后才展示菜单项
	static showCommand() {
		return !!LeftMenus.getRapidMenus();
	}

	/**
	 * 获取快捷菜单配置
	 * 优先从工作区 settings.json（VS Code 设置）读取，未配置时托底从 package.json 读取
	 */
	static getRapidMenus(): { [key: string]: any } | null {
		// 优先从 settings.json 读取
		const settingsMenus = vscode.workspace.getConfiguration().get('rapidMenus');
		if (settingsMenus) {
			return <{ [key: string]: any }>settingsMenus;
		}
		// 托底：从 package.json 读取
		const packageJSON = utils.readPackageJson();
		return packageJSON?.rapidMenus || null;
	}
	// 菜单--启动
	static startup(): void {
		// scripts：package.json中配置的命令；rapidMenus：快捷菜单配置（settings.json 优先，托底 package.json）
		const scripts: { [key: string]: string } = utils.readPackageJson()?.scripts || {};
		const rapidMenus = LeftMenus.getRapidMenus();
		// 获取要执行的指令
		const script = <string>menuUtils.getScript("startup", rapidMenus);
		if (script) {
			const scriptNames = <string[]>menuUtils.splitScripts(script);
			scriptNames.forEach((name: string) => {
				LeftMenus.createTerminalAndExec(name, scripts);
			});
		} else {
			vscode.window.showErrorMessage("配置格式不符合要求");
		}
	}

	// 创建终端并执行
	static createTerminalAndExec(name: string, scripts: { [key: string]: string }): void {
		if (!scripts || !scripts[name]) {
			vscode.window.showErrorMessage(`package.json中未配置${name}指令`);
			return;
		}
		let shell = vscode.window.createTerminal(name);
		shell.show(true);
		shell.sendText(`npm run ${name}`);
		vscode.window.showInformationMessage(`终端【${name}】正在运行...`);
	}
}
