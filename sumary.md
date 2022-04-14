## 总结
### 编写自己的第一个vscode
#### 配置指令：
    
1、在package.json中配置指令。

```
"activationEvents": [
    "onCommand:hello.vscode"
],
"contributes": {
    "commands": [
        {
            "command": "hello.vscode",
            "title": "Hello vscode"
        }
    ]
}
```

2、在代码中注册指令。
```
let disposable = vscode.commands.registerCommand('hello.vscode', () => {
    vscode.window.showInformationMessage('Hello World from Hello vscode!');
});

context.subscriptions.push(disposable);
```

3、操作指令。

在调试窗口按住`ctrl+shift+P`打开命令输入框，输入package.json内配置的指令的title：`hello vscode` ，会在调试窗口底部弹出`Hello World from Hello vscode!`