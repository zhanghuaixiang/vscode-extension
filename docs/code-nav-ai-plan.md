# 代码理解面板 AI 增强计划（A 阶段）

背景：D 阶段交付后，面板已经能给出结构、契约、状态流转、时间轴与函数影响面，且每条结论都能定位到原文件行。下一步是接入大模型，把“读懂”这一层补上——但必须保持既有能力完全离线可用。

## 边界

- **内核 `analyze()` 永不联网**。AI 走独立通道，结果不进 `CodeNavResult`，避免污染 v1 协议。
- AI 结论与静态事实**分层可辨**：面板必须让用户一眼看出哪句是源码事实、哪句是模型推断。
- AI 产出的每条结论必须带行号，且行号要落在本文件已有节点的行范围内；越界引用一律丢弃。
- `AI.enable` 关闭时，面板行为与现在完全一致，且**零网络请求**。
- 不做跨文件问答、不自动改写源码、不把 AI 结论写进 `certainty`。

## 通道

大模型相关配置**只有一组** `AI.*`（OpenAI 兼容网关），由简繁英转换与代码理解 AI 解读共用，读配置统一走 `src/aiConfig.ts`：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `AI.baseUrl` | `""` | 接口地址，OpenAI 兼容 |
| `AI.model` | `"yunzhongzi"` | 模型名，两个功能共用 |
| `AI.apiKey` | `""` | 按 `Authorization: Bearer` 发送；内网网关可留空 |
| `AI.enable` | `false` | 代码理解面板 AI 解读开关；关闭时不发起任何请求 |

`AI.baseUrl` / `AI.model` 已有值才认为网关可用（`gatewayIssue`）；`apiKey` 允许留空。`AI.*` 任一项变化时面板即时刷新，无需重载窗口。prompt 模板版本由代码内常量 `AI_PROMPT_VERSION` 控制，变化即让缓存失效。

## 结构

```
codeNavCore.analyze()  →  CodeNavResult  ──┐
                                           ├→ codeNavAi.buildContext() → aiClient.chat() → codeNavAi.parseInsight() → AiInsight
editor 文本快照 ──────────────────────────┘                                            ↑ 行号校验（防幻觉）
                                                  ↑
                          aiConfig.readAiSettings()（AI.baseUrl / AI.model / AI.apiKey）
```

- `src/aiClient.ts`：通用 OpenAI 兼容调用（`fetch` + 超时/取消 + 剥离 markdown 围栏 + 降级错误），入参为消息数组；另含 `resolveGateway`（去空格归一化）、`gatewayIssue`（未配置时不发请求）与 `AiInsightCache`。
- `src/aiConfig.ts`：读取 `AI.*`（含 `AI.enable`），供 `aiClient` 的两个调用方（`enConverter` 与代码理解面板）共用；只依赖 `vscode`，逻辑极薄。
- `src/enConverter.ts`：改造为调用 `aiClient.chat()`，自身只保留翻译提示词与命令注册，删除了原先那份独立的 `fetch` / 超时 / 剥围栏代码。
- `src/codeNavAi.ts`：`buildContext`（上下文构造）、`parseInsight`（解析 + 行号校验）、`isKnownLine`（跳转白名单）、`insightCacheKey`（缓存键）。全部为纯函数，便于单测。

## 上下文构造

用结构化结果做骨架，**只按需带源码切片**，不把整份源码交给模型：

- 文件级：`fileType`、`totalLines`、`guide.summary`（标注是否作者原话）、入口名、`contract.props` / `emits` 摘要、`flows`（名称 + 读/写数量 + 模板行）、`functions[]`（签名 + 语义标记 + 调用与写入面名称）、`timeline`（kind + 名称 + 行）、`comments[]` 原文。
- 节点级：以上内容外加该节点 `range` 对应的源码切片（按行截取并设上限）。
- Prompt 约束：只做解释与归纳，**不得编造调用关系、读写关系或运行时顺序**；每条结论后用 `[L起-L止]` 标注依据行号。

## 校验与失效

- `parseInsight` 解析 `[Lx]` / `[Lx-Ly]`，逐行检查是否落在本文件节点的行范围内：命中则保留并入 `evidence`，全部越界的引用整条删除并计入 `dropped`。面板跳转复用同一白名单（`isKnownLine`），因此**面板上不会出现指向未知行的 AI 链接**。
- 缓存键 = `sha256(文件文本) | scope | model | AI_PROMPT_VERSION`，命中则不再请求，避免重复计费；缓存为进程内 LRU（最多 20 条、TTL 30 分钟）。
- `state` 消息携带 `snapshotId`（= 文件文本 sha256）：`snapshotId` 变化时面板**整体清空**旧的 AI 解读，不静默沿用（等价于提示重新生成）；切文件或重新分析时用 `AbortController` 取消所有在途请求，回传时再校验 `snapshotId` 一致，旧回答不会落到新文件上。

## 展现形式

1. **文件级**：guide 顶部「作者原话」摘要下方并列一个「AI 解读」区块。
   - 未启用 → 一行配置提示 + 「去配置」按钮，不发请求。
   - 生成中 → 「正在生成」。
   - 就绪 → 文本 + 行号链接（复用 `revealLine`）+ 「AI 推断」标签 + 模型名 + 「重新生成」。
2. **节点级**：函数卡片与状态流转行右上角新增「AI」按钮，点击就地展开该节点解释，懒加载、单节点单请求。
3. **视觉区分**：新增 `.ai-block` / `.ai-badge`，与 `.doc-block`（作者原话）明显区别，保证 AI 推断不会被当成源码事实。

## 阶段

| 阶段 | 内容 | 通过条件 |
| --- | --- | --- |
| A1 | `buildContext` + `parseInsight` + 行号校验（纯函数） | 单测覆盖：越界行号被过滤、合法行号保留、上下文含必要字段、节点级切片带源码 |
| A2 | `aiClient` + 缓存 + 取消/过期（注入 fake fetcher） | 未启用或未配置时不发请求；超时与错误可降级；缓存键稳定且随文本变化而失效 |
| A3 | 面板 UI + 配置项 + 协议与计划文档同步 | `compile` + `lint` + 全量测试通过 |
| A4 | 大模型配置整合为 `AI.*` 一组（含 `apiKey`），`enConverter` 改用同一通道 | 两个功能都不再各自读配置；`compile` + `lint` + 全量测试通过 |

每个阶段完成前必须 `compile` + `lint` + 全量测试通过，再进入下一阶段。

## 进度

| 阶段 | 状态 | 落地位置 |
| --- | --- | --- |
| A1 | 已完成 | `src/codeNavAi.ts`、`src/test/suite/codeNavAi.test.ts`（6 例） |
| A2 | 已完成 | `src/aiClient.ts`、`src/test/suite/aiClient.test.ts`（9 例，注入 fake fetcher，不发真实请求） |
| A3 | 已完成 | `src/codeNavPanel.ts`、`media/code-nav.js` / `code-nav.css`、`package.json` 的 `AI.enable` |
| A4 | 已完成 | `package.json` 的 `AI.baseUrl` / `AI.model` / `AI.apiKey`（旧 `Converter.enUrl` / `Converter.AIModel` / `CodeNav.aiModel` 已移除）、`src/aiConfig.ts`、`src/enConverter.ts` |

AI 默认关闭（`AI.enable: false`），因此**升级后行为与 A 阶段之前完全一致**；开启后也只在用户点击「生成解读」或节点上的「AI」按钮时才发起请求。

## 迁移

`Converter.enUrl` / `Converter.AIModel` 已删除，原先的接口地址与模型名需要改写到 `AI.baseUrl` / `AI.model`（`AI.model` 默认仍是 `yunzhongzi`，与旧默认一致）。旧键会以「未知配置」提示出现在 settings.json 里，可自行清理；`Converter.enLabel`（简转EN 提示词）保留在 `Converter` 分组，因为它属于该功能自身而非连接配置。
