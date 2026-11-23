# pi-chat-navi

[pi coding agent](https://github.com/earendil-works/pi-coding-agent) 扩展：在 TUI 里用 `/questions` 打开「用户提问列表」浮动面板，用键盘选择后回车即可跳回会话中的任意一次提问。

## 功能

- 面板停靠在右上角，列出**当前 transcript 实际显示**的用户提问（序号 + 摘要）；被压缩掉的旧提问不会出现。列表放不下时，上下会显示 `↑ more` / `↓ more`
- 键盘：↑↓ 选择，回车（或空格）跳转，→ 或 `d` 进入该提问的「回合分析」，Esc 关闭（回合分析内 ←/Esc 先返回列表，`t` 切换仅看思维链）
- 鼠标仅支持回合分析详情区的滚轮（详情区右侧显示滚动条）；单击/双击/悬停均无效果
- 宽度：默认 60%。`/questions 50` 指定列数，`/questions 60%` 指定百分比。设置在会话内记忆；面板已打开时带参数会以新宽度重开

## 安装

```
pi install <本仓库路径或 git 地址>
```

开发时直接加载：`pi -ne -e .`（入口为 `package.json` 里 `pi.extensions` 指向的 `src/index.ts`）

## 代码结构

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 注册 `/questions`，解析宽度参数，把下面三部分接起来 |
| `src/logic.ts` | 纯逻辑：会话条目 → 提问列表、标记序号、回合分析。不依赖 pi |
| `src/jump.ts` | 跳转。**所有依赖 pi TUI 内部实现的代码都在这里** |
| `src/panel.ts` | 面板组件：状态、键鼠、渲染。不碰会话数据和 transcript |

## 测试

```
npm install           # 首次需要：契约测试依赖 devDependencies 里的真实 pi 包
npm run typecheck     # tsc 类型检查
npm test              # 逻辑单测 + 契约测试（针对 devDependencies 里装的 pi 版本）
npm run test:compat   # 用 npm 上最新的 pi 版本跑契约测试
npm run test:compat -- 1.6.0 latest   # 指定多个版本
```

- `test/logic.test.mjs`：`logic.ts` 的纯函数。
- `test/contract.test.mjs`：用真实的 `TuiAltScreen`、`ScrollView`、`UserMessageComponent`、`AssistantMessageComponent`
  按 pi 的挂载方式搭一段 transcript，验证 `jump.ts` 与 `logic.ts` 对 pi 的假设：布局字段是否存在、
  OSC 133;A 标记数量与序号是否与推算一致、标记法和文本匹配兜底是否都落在正确行。
  pi 改了内部实现时，失败信息会指出是哪个字段或规则变了。
- 升级 pi 前后，运行 `npm run test:compat`；失败时先看失败信息指出的是哪条假设：跳转相关的改 `src/jump.ts`，
  标记数量/顺序相关（OSC 133;A 由哪些消息写入）的改 `src/logic.ts` 里镜像 pi 渲染规则的部分
  （`assistantWritesMarker`、`renderedUserText`）。
- `test:compat` 与 `scripts/` 仅在本仓库内可用，不随 npm 包发布。
- 契约测试能证明「逻辑上的假设仍成立」，不能代替在真实 pi 里手动按一次 `/questions` 回车。

## 说明

- 列表与标记序号基于 `sessionManager.buildContextEntries()`（压缩后的活动上下文），与 transcript 渲染一致；纯图片/空白的用户消息不会渲染组件，会被跳过。
- 跳转优先使用 transcript 里的 OSC 133;A 标记定位；标记失效（pi 改动标记规则）时自动退回文本匹配（遍历 `UserMessageComponent`，按归一化文本 + 渲染首行出现序定位）。
- 跳转仍依赖 pi TUI 的内部布局对象；pi 升级若改动这些内部实现，只有跳转会失效（会提示），面板本身不受影响。

## 许可

MIT
