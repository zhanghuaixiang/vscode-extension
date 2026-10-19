/**
 * author: 张怀祥
 * desc: 左侧菜单栏 
 */
import * as vscode from 'vscode';
import utils from './utils/utils';

export default class LeftMenus {
	static commands: Array<vscode.Disposable> = [];
	static init() {
		// 兼容老版本：配置未设置时，从工作区 package.json 迁移一次
		void LeftMenus.seedFromPackageJson();
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
		return LeftMenus.getStartupScripts().length > 0;
	}

	/**
	 * 兼容迁移：老版本把快捷菜单写在（工作区）package.json 的 rapidMenus 里。
	 * 插件配置未设置 rapidMenus 时，取 package.json 的值写回为插件配置；两者都没有则保持为空。
	 * 写回后 inspect 即判定为“已配置”，因此不会因 onDidChangeConfiguration 反复写回。
	 */
	static async seedFromPackageJson(): Promise<void> {
		const config = vscode.workspace.getConfiguration();
		const info = config.inspect<string[]>("rapidMenus");
		const configured = !!info && (
			info.globalValue !== undefined ||
			info.workspaceValue !== undefined ||
			info.workspaceFolderValue !== undefined
		);
		if (configured) {
			return;
		}
		const scripts = LeftMenus.normalizeLegacy(utils.readPackageJson()?.rapidMenus);
		if (!scripts.length) {
			return;
		}
		try {
			await config.update("rapidMenus", scripts, vscode.ConfigurationTarget.Workspace);
		} catch {
			// 配置不可写时忽略，菜单保持隐藏
		}
	}

	/**
	 * 兼容老版 package.json 里的 rapidMenus 形态：
	 * - string[]：新形态
	 * - string：按 && 拆分成多个脚本
	 * - { startup: string | { script: string } | string[] }：取 startup 后同上
	 */
	static normalizeLegacy(value: any): string[] {
		let raw: any = value;
		if (raw && !Array.isArray(raw) && typeof raw === "object") {
			raw = raw.startup;
		}
		if (raw && !Array.isArray(raw) && typeof raw === "object") {
			raw = raw.script;
		}
		const items: any[] = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split("&&") : [];
		return items
			.filter(item => typeof item === "string")
			.map(item => item.trim())
			.filter(item => !!item);
	}

	/**
	 * 获取启动脚本配置：设置面板里的 rapidMenus 列表（每项是一个 npm script 名称）
	 */
	static getStartupScripts(): string[] {
		const configured = vscode.workspace.getConfiguration().get<string[]>("rapidMenus");
		if (!Array.isArray(configured)) {
			return [];
		}
		return configured
			.filter(item => typeof item === "string")
			.map(item => item.trim())
			.filter(item => !!item);
	}

	// 菜单--启动
	static startup(): void {
		// scripts：当前工作区 package.json 中配置的命令
		const scripts: { [key: string]: string } = utils.readPackageJson()?.scripts || {};
		const scriptNames = LeftMenus.getStartupScripts();
		if (!scriptNames.length) {
			vscode.window.showErrorMessage("配置格式不符合要求");
			return;
		}
		scriptNames.forEach((name: string) => {
			LeftMenus.createTerminalAndExec(name, scripts);
		});
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
