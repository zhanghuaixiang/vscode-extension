// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import LeftMenus from "./leftMenus";
import ReadI18n from "./readI18n";
import CN2TW from "./cn2tw";
import ENConverter from './enConverter';
import { registerCodeNavPanel } from './codeNavPanel';

// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
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
