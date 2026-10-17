# 单文件代码导航内核 v1 协议

M1 交付。与 VS Code 无关的入口是 `analyze(source, fileName)`（`src/codeNavCore.ts`）；CLI 与 worker 复用同一实现。输入为当前文件的文本快照和名称，仅支持 `.vue` / `.js`；不会读取或遍历用户项目的其他文件。

## 输出

`CodeNavResult` 的完整 TypeScript 定义见 `src/codeNavTypes.ts`。所有源码位置以**原文件**为基准，行、列从 1 开始；`endLine/endColumn` 为结束位置（不含）。节点 ID 在同一个文本快照内可用，不保证修改代码后仍然稳定。

| 字段 | 含义 |
| --- | --- |
| `version: 1`、`file`、`fileType` | 协议版本、调用方给出的文件名、`vue` 或 `js` |
| `meta` | 总行数、明确声明的组件名（否则 `null`）、文件大小档位 |
| `nodes` | 扁平的源码节点表：`id/name/kind/range`，部分节点有子节点 ID；`doc` 为紧贴其上方的作者注释 |
| `template` | `.vue` 的标签树、属性和监听器；`.js` 为 `null` |
| `script` | 声明、导出、props、data、computed、watch、生命周期及确定性方法分组；数组项均引用 `nodes[].id` |
| `imports` | 当前文件的静态 import 和可识别的顶层 `require` 节点 ID，不递归解析依赖 |
| `doc` | 脚本块顶部与首个语句直接相邻的作者注释，含 `@tag` 解析结果；没有则为 `null` |
| `comments` | TODO / FIXME / HACK 与模板备注、行尾备注，按行排序，正文照抄原文 |
| `contract` | 组件对外契约与状态流转：`props`、`emits`、`slots`、`injections`、`flows`；引用 `nodes[].id` |
| `timeline` | 初始化与生命周期步骤（`state` / `computed` / `watch` / `hook`），按源码出现位置推定顺序 |
| `functions` | 函数卡片：签名、`isAsync`、`hasReturn`、`errorHandling`、`params`、`callers`、`callees`、`writes` |
| `guide` | 基于明确源码事实的摘要、入口和状态节点 ID；`summary.origin` 为 `comment` 表示引用作者原话，`structure` 表示结构事实 |
| `paths` | 文件内关系：`from`、可选 `to`、类型、确定性与证据位置 |
| `errors` | 可恢复诊断，包含消息、可用时的原文件行号和出错区块 |

关系类型包括 `event-handler`、`calls`、`writes`、`exports` 和 `returns`。`certainty: "certain"` 仅表示当前文件的**静态语法目标唯一可确定**，并不证明该代码在运行时一定执行。无法确定的关系用 `certainty: "unresolved"`，不填写 `to`，并提供 `targetName`（可识别时）和 `reason`；不要在面板中将其画成确定的连线。M1 不输出风险扫描结果，也不做 LLM 推断。

作者注释只做两件事：原样抄录与定位。节点级 `doc` 只认**紧贴节点上方且独占整行**的注释，行尾注释归入 `comments` 而不归属该节点；`TODO` / `FIXME` / `HACK` / `XXX` / `BUG` 开头的注释一律进 `comments`，不当函数说明。注释不参与任何关系判定，也不会提高 `certainty`。`summary.origin` 为 `comment` 时，`text` 是作者原文的长度截断，未做改写。

`contract` 描述“组件对外怎么用、状态在本文件内被谁读谁写”，全部只依赖当前文件的静态语法：

- `props[]`：`name`、`type`（按源码原样，如 `Number | String`）、`required`、`defaultText`、`hasValidator`、`source`（`object` / `array` / `type`）。`type` 为 `defineProps<Props>()` 时按本文件 `interface` / `type` 解一次引用；无法确认的字段为 `null` / `false`，不做推断。
- `emits[]`：`declared` 表示是否在 `emits` 中声明，`declarationLine` 为声明行；`triggers[]` 是本文件内 `this.$emit('x')` / `emit('x')` 的触发点（`ownerName` + `line`），只统计参数为静态字符串的调用。
- `slots[]`：模板里 `<slot>` 的名字（匿名记为 `default`）、行号与是否作用域插槽。
- `injections[]`：`provide` / `inject` 的键、行号与 `certainty`；键不是静态字符串时标 `unresolved` 并给出 `reason`。
- `flows[]`：每个 prop / state / computed 的 `reads`、`writes`（指向本文件的函数节点）、`watches` 与 `templateLines`（模板里引用它的行）。读取判定跳过赋值左侧、更新表达式、声明 id、对象键与类型引用；`this.x` 视为读取，`this.x =` / `x.value =` / 裸 `x =` 视为写入。`v-for` / `v-slot` 引入的局部别名不计入。

`contract` 只描述本文件可确认的事实，不表示运行时真实顺序，也不构成跨文件契约。

`timeline` 与 `functions` 回答“初始化与生命周期大致按什么顺序发生、改一个函数会波及本文件哪些位置”，同样只依赖当前文件的静态语法：

- `timeline[]`：`name`、`kind`（`state` / `computed` / `watch` / `hook`）、`id`（引用 `nodes[].id`）与 `line`；按源码出现位置排序，属于**顺序推定**，不代表运行时真实执行顺序。
- `functions[]`：每个函数 / 方法一张卡片。`signature` 为 `async? name(params)` 形式，`params` 按源码原样切分；`isAsync`、`hasReturn`（块体是否有带值的 `return`，箭头表达式体视为隐式返回）、`errorHandling`（是否出现 `try`）均为语法事实；`callers`、`callees`、`writes` 复用 `paths` 里 `certainty: "certain"` 的 `calls` / `writes` 关系，跨文件或无法唯一解析的调用不进入卡片。

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
- `contract.flows` 只覆盖本文件可见的具名状态；模板引用来自元素属性表达式（例如 `:item="x"`、`@click="x"`），纯文本插值 `{{ x }}` 暂不计入 `templateLines`。跨文件读写、动态键、运行时真实执行顺序都不在 v1 范围内。
- `timeline` 的顺序是源码出现位置的推定，不解释 `watch` 的触发时机或异步先后；`functions[].callers` / `callees` / `writes` 只包含本文件内唯一可确定的调用与写入，外部依赖一律不计。
- 巨型文件应由 worker 分析，M2/M3 再实现结果缓存、首屏裁剪和面板懒渲染。M0 的 Webview 资源探针暂留作集成回归，下一阶段由正式面板替代。
