// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import LeftMenus from "./leftMenus";
import ReadI18n from "./readI18n";
import CN2TW from "./cn2tw";
import ENConverter from './enConverter';
import { registerCodeNavPanel } from './codeNavPanel';

interface SettingDeclaration {
	default?: unknown;
}

/** 汇总 package.json 里声明的全部配置项（contributes.configuration 允许是数组）。 */
function declaredSettings(context: vscode.ExtensionContext): Record<string, SettingDeclaration> {
	const declared: Record<string, SettingDeclaration> = {};
	const raw = context.extension.packageJSON?.contributes?.configuration;
	const blocks = Array.isArray(raw) ? raw : raw ? [raw] : [];
	for (const block of blocks) {
		Object.assign(declared, block?.properties);
	}
	return declared;
}

/**
 * 覆盖安装新版本后，VS Code 主进程里注册的配置 schema 仍是旧的：边栏与命令已经是新代码，
 * 但设置面板只显示老版本的配置项，要重载窗口才会刷新。
 * 这里用「声明里带 default、注册表里却读不到 defaultValue」来判定 schema 过期，
 * 过期时给一次性提示，免得用户在设置面板里找不到新配置项。
 */
function warnIfSettingsSchemaStale(context: vscode.ExtensionContext): void {
	const settings = declaredSettings(context);
	const config = vscode.workspace.getConfiguration();
	const stale = Object.entries(settings).some(([key, declaration]) =>
		declaration.default !== undefined && config.inspect(key)?.defaultValue === undefined);
	if (!stale) { return; }
	void vscode.window.showInformationMessage(
		'Rapid Tools 已更新：设置面板里的新配置项需要重新加载窗口后才会出现。',
		'重新加载窗口'
	).then((choice) => {
		if (choice === '重新加载窗口') {
			void vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	});
}

// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	warnIfSettingsSchemaStale(context);
        registerCodeNavPanel(context);
	CN2TW.init(context.subscriptions);
	ENConverter.init(context.subscriptions);
	LeftMenus.init();

	// i18n 配置来自 settings.json，不再依赖 package.json
	ReadI18n.init();
	context.subscriptions.push({ dispose: () => ReadI18n.dispose() });

	// 监听settings.json配置变化，变化后重新初始化对应功能
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration('rapidMenus')) {
			LeftMenus.init();
		}
		if (e.affectsConfiguration('I18n')) {
			ReadI18n.init();
		}
	}));
}

// this method is called when your extension is deactivated
export function deactivate() {
	// 所有资源均通过 context.subscriptions 自动释放
}
