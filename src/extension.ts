// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
const fs = require("fs");
const path = require("path");

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	
	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "hello" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	let disposable = vscode.commands.registerCommand('hello.helloworld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from Hello vscode!');
	});
	vscode.commands.registerCommand('hi.harri', () => {
		vscode.window.showInformationMessage('你好，这是harri的第一个vscode插件');
	});

	vscode.commands.registerCommand("start.a", () => {
		vscode.window.showInformationMessage('你好，左侧菜单---启动');
		const packagePath = path.join(vscode.workspace.rootPath, "package.json");
		if(fs.existsSync(packagePath)) {
			const packageJSON = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
			// console.log(packageJSON);
			const scripts = packageJSON.scripts;
			console.log(scripts.dev);
			console.log(vscode.window);
			vscode.window.createTerminal("dev");
			const exec = require("child_process").exec;
			exec(scripts.dev, (error: any)=>{
				// console.log(a1,b1,c1);
				console.log(error)
			});
			// new vscode.ShellExecution('yarn dev');
			console.log("liale了");
			
		} else {
			vscode.window.showErrorMessage("根目录下未找到package.json");
		}
		
	});

	context.subscriptions.push(disposable);
}

// this method is called when your extension is deactivated
export function deactivate() {}
