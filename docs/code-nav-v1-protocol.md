# 单文件代码导航内核 v1 协议

M1 交付。与 VS Code 无关的入口是 `analyze(source, fileName)`（`src/codeNavCore.ts`）；CLI 与 worker 复用同一实现。输入为当前文件的文本快照和名称，仅支持 `.vue` / `.js`；不会读取或遍历用户项目的其他文件。

## 输出

`CodeNavResult` 的完整 TypeScript 定义见 `src/codeNavTypes.ts`。所有源码位置以**原文件**为基准，行、列从 1 开始；`endLine/endColumn` 为结束位置（不含）。节点 ID 在同一个文本快照内可用，不保证修改代码后仍然稳定。

| 字段 | 含义 |
| --- | --- |
| `version: 1`、`file`、`fileType` | 协议版本、调用方给出的文件名、`vue` 或 `js` |
| `meta` | 总行数、明确声明的组件名（否则 `null`）、文件大小档位 |
| `nodes` | 扁平的源码节点表：`id/name/kind/range`，部分节点有子节点 ID |
| `template` | `.vue` 的标签树、属性和监听器；`.js` 为 `null` |
| `script` | 声明、导出、props、data、computed、watch、生命周期及确定性方法分组；数组项均引用 `nodes[].id` |
| `imports` | 当前文件的静态 import 和可识别的顶层 `require` 节点 ID，不递归解析依赖 |
| `guide` | 基于明确源码事实的摘要、入口和状态节点 ID；无法证实时摘要可为 `null` |
| `paths` | 文件内关系：`from`、可选 `to`、类型、确定性与证据位置 |
| `errors` | 可恢复诊断，包含消息、可用时的原文件行号和出错区块 |

关系类型包括 `event-handler`、`calls`、`writes`、`exports` 和 `returns`。`certainty: "certain"` 仅表示当前文件的**静态语法目标唯一可确定**，并不证明该代码在运行时一定执行。无法确定的关系用 `certainty: "unresolved"`，不填写 `to`，并提供 `targetName`（可识别时）和 `reason`；不要在面板中将其画成确定的连线。M1 不输出风险扫描结果，也不做 LLM 推断。

## 调用与错误

编译后执行：

```powershell
node dist/codeNavCli.js path/to/file.vue
node dist/codeNavCli.js path/to/file.js
```

CLI 将**单行 JSON**写入 stdout；退出码 `0` 表示无解析诊断，`2` 表示已输出部分 JSON 但 `errors` 非空，`1` 表示参数或读取文件失败。扩展可用当前未保存的 `TextDocument.getText()` 调用内核或 worker，无须落盘。worker bundle 为 `dist/codeNavWorker.js`，从扩展安装路径定位。

## 已知边界

- Vue 模板的简单事件表达式（例如 `save`、`save($event)`）仅在本文件存在唯一处理函数时连线；复杂表达式、模板局部作用域、动态属性和跨文件目标保持未确认。
- Vue Options API、`script setup`、普通 JS ESM / CommonJS 的常见结构可解析；`data()` 返回的静态对象属性及已声明的 `this.state` 写入可连线。不会解释业务职责或推断完整运行时调用链。
- 对脚本语法错误保留可识别的分区与模板，诊断不导致空白结果；不支持的预处理语法与特殊 JSX/TSX 变体仍需真实项目样本回归。
- 巨型文件应由 worker 分析，M2/M3 再实现结果缓存、首屏裁剪和面板懒渲染。M0 的 Webview 资源探针暂留作集成回归，下一阶段由正式面板替代。
