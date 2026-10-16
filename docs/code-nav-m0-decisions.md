# 单文件代码理解面板 M0 技术验证记录

验证日期：2026-10-16。范围仅限 [执行计划](code-nav-execution-plan.md) 的 M0；当前 `rapidTools.m0Probe` 是最小探针，不是正式代码理解面板。

## 验证结果

| 问题 | 证据 | 决策 |
| --- | --- | --- |
| Vue / JS 解析能否进入现有扩展 | `@vue/compiler-sfc@3.5.44` 和 `@babel/parser@7.29.9` 已通过 yarn 安装；`npm run compile`、类型检查、lint 通过；打包后 `dist/codeNavM0Core.js` 可在 Node 中解析 `.vue` / `.js`，`script setup lang=ts` 最小样例也通过 | 内核实现为编辑器无关的纯函数；扩展和未来 CLI 使用同一源码。M1 才定义正式 JSON 与 CLI 参数 |
| 解析器如何随 webpack 打包 | compiler-sfc 的默认 Node 入口触发数十个可选模板预处理器的缺失依赖，构建失败；改用其 `esm-browser` 入口后构建成功，仍有 3 条动态 `require` 警告 | 暂用 webpack alias 指向浏览器入口，仅做 SFC 解析，不提供模板预处理能力。M1 对真实 Vue 2/3 样本回归，并调查警告是否影响实际解析；不屏蔽未验证的警告 |
| worker / CLI 共享内核的包内路径 | webpack 生成 `dist/extension.js`、`dist/codeNavM0Worker.js`、`dist/codeNavM0Core.js`；worker 在 Node 和 VS Code 扩展宿主中均可返回解析结果；独立 core bundle 可由 Node 直接 `require` | worker 使用 `context.extensionPath/dist/...` 的安装路径；CLI 后续只包装共享内核，不依赖用户项目的 `node_modules`。M1 可再优化重复打包的体积 |
| Webview / 资源加载 | View Provider 在隔离版 VS Code 1.142.0 的扩展宿主中可解析；带 nonce 的 CSP 下浏览器脚本回报 `ready`，经 `asWebviewUri` 和 `localResourceRoots` 加载的包内 `images/icon.png` 回报成功 | 使用受限资源根、nonce CSP 和消息白名单。当前只验证最小探针，不代表正式 UI 设计已定 |
| 视图默认位置 | `contributes.viewsContainers.activitybar` 可注册活动栏容器；带点号的容器 ID 被 VS Code 拒绝，改为 `rapidToolsM0` 后通过宿主测试 | 不承诺插件可强制把视图固定在右侧；第一版默认活动栏位置，提供移至右侧辅助侧边栏的使用指引 |
| VSIX 内容 | `vsce package --no-dependencies` 生成 17 个文件、约 1.32 MB 的测试 VSIX；隔离目录安装成功，包内含 3 个 bundle、manifest 与 Webview 图片 | 扩展依赖由 webpack 打包。`.vscodeignore` 排除工作区无关的 `.kilo/**` 和用户现有 `package-lock.json`；不发布这些文件，也不删除原件 |

## 大文件基线

基于合成的 173,000 行、约 3.93 MB 文件，使用已打包的 `probeParse` 在本机 Node 24.14.1 中单次测得：

| 文件 | 耗时 | 结束时进程堆内存 |
| --- | --- | --- |
| `.js`（17.3 万条简单声明） | 约 670 ms | 约 232 MB |
| `.vue`（同规模 script 加简短 template） | 约 2,554 ms | 约 413 MB |

这些数字不是吞吐承诺，也不代表真实业务文件的分支、模板树或 Webview 渲染开销。M1/M3 应在后台解析大文件，限制首屏节点数和返回数据体积，并用真实样本重新测量峰值内存、解析耗时、首次可交互时间和扩展宿主响应性。

## 验收与遗留项

- `npm run compile-tests`、`npm run lint` 通过；隔离版 VS Code 1.142.0 的扩展宿主测试 3/3 通过，覆盖主线程解析、worker 解析、视图解析和 Webview 浏览器侧图片加载。
- 本机安装的 VS Code 1.141.2 因更新互斥锁拒绝启动扩展测试；改用测试框架已有的隔离版 VS Code 完成验证。该失败与插件断言无关。
- 早期 VSIX 已在独立扩展目录安装并通过宿主测试。最终 VSIX（含浏览器侧图片回报）直接解包后，从包内 `extension/` 路径运行相同测试，3/3 通过；本机 CLI 对最终包的再次隔离安装受更新 / 沙箱目录限制，故不声称最终包完成了第二次安装。解包运行验证了实际打包内容，但不替代正式发布前的安装回归。
- `vsce` 提示缺少 LICENSE 文件，webpack 留有 3 条来自 compiler-sfc 浏览器构建的动态 `require` 警告；发布前分别确认许可证文件和这些警告的实际影响。
- M1 需收集真实 Vue 2/3、JS ESM / CommonJS 和巨型文件样本；JSX / TSX、特殊模板预处理语法尚未验证，不能默认宣称支持。M0 探针视图与命令在 M1 应替换为正式能力，发布前不保留诊断入口。
