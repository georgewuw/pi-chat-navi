# pi-chat-navi

npm 包：`@georgewuw/pi-chat-navi`

[pi coding agent](https://github.com/earendil-works/pi-coding-agent) 扩展：在 TUI 里用 `/questions` 打开「用户提问列表」浮动面板，用键盘选择后回车即可跳回会话中的任意一次提问。

## 功能

- 面板停靠在右上角，列出**当前 transcript 实际显示**的用户提问（序号 + 摘要）；被压缩掉的旧提问不会出现。列表放不下时，上下会显示 `↑ more` / `↓ more`
- 键盘：↑↓ 选择，回车（或空格）跳转，→ 或 `d` 进入该提问的「回合分析」，Esc 关闭（回合分析内 ←/Esc 先返回列表，`t` 切换仅看思维链）
- 鼠标仅支持回合分析详情区的滚轮（详情区右侧显示滚动条）；单击/双击/悬停均无效果
- 宽度：默认 60%。`/questions 50` 指定列数，`/questions 60%` 指定百分比。设置在会话内记忆；面板已打开时带参数会以新宽度重开

## 安装

从 npm 安装（推荐）：

```
pi install npm:@georgewuw/pi-chat-navi          # 最新版
pi install npm:@georgewuw/pi-chat-navi@0.1.0    # 固定版本
```

也可以从 git 或本地路径安装：

```
pi install git:github.com/georgewuw/pi-chat-navi
pi install ./pi-chat-navi
```

安装后重启 pi，在会话里输入 `/questions` 即可。

只试用一次、不写入设置：

```
pi -e npm:@georgewuw/pi-chat-navi
```

### 本地开发

本仓库使用 pnpm（`package.json` 的 `packageManager` 已固定版本，lockfile 为 `pnpm-lock.yaml`）：

```
corepack enable   # 首次使用：让 corepack 按 packageManager 准备 pnpm
pnpm install
pi -ne -e .       # pi 用 jiti 直接加载 src/index.ts，无需构建
```

`package.json` 的 `pi.extensions` 指向 `./src/index.ts`；修改 `src/` 后重新加载即可。

## 代码结构

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 注册 `/questions`，解析宽度参数，把下面三部分接起来 |
| `src/logic.ts` | 纯逻辑：会话条目 → 提问列表、标记序号、回合分析。不依赖 pi |
| `src/jump.ts` | 跳转。**所有依赖 pi TUI 内部实现的代码都在这里** |
| `src/panel.ts` | 面板组件：状态、键鼠、渲染。不碰会话数据和 transcript |

入口就是 `src/index.ts`：pi 通过 jiti 直接执行 `.ts`，不需要编译产物。

## 测试

```
pnpm install            # 首次需要：契约测试依赖 devDependencies 里的真实 pi 包
pnpm run typecheck      # tsc 类型检查（含 test/，tsconfig 的 include 覆盖 src 与 test）
pnpm test               # 逻辑单测 + 契约测试（针对 devDependencies 里装的 pi 版本）
pnpm run test:compat    # 用 npm 上最新的 pi 版本跑契约测试
pnpm run test:compat -- 1.6.0 latest   # 指定多个版本
pnpm run test:compat -- --keep 1.6.0   # 保留临时目录便于排查
pnpm run test:compat -- --verbose 1.6.0 # 失败时打印完整测试输出
```

- `test/logic.test.ts`：`logic.ts` 的纯函数。
- `test/contract.test.ts`：测试本身也是 TypeScript，用 `node --test` 直接跑（Node 22 原生类型剥离），
  不依赖 ts-node/tsx，也不需要先构建；同时 `pnpm run typecheck` 会把它们一起检查，
  所以 fixture 写错字段（例如构造会话条目时拼错 `stopReason`）会在编译期就报错。
  内容上：按 pi 的挂载方式搭一段 transcript，验证 `jump.ts` 与 `logic.ts` 对 pi 的假设：布局字段是否存在、
  OSC 133;A 标记数量与序号是否与推算一致、标记法和文本匹配兜底是否都落在正确行。
  pi 改了内部实现时，失败信息会指出是哪个字段或规则变了。
  （只剩一处 `as unknown as`：`AssistantMessage` 必填的 `api`/`provider`/`model`/`usage` 与渲染无关，
  fixture 不构造它们。读 `scrollTop` 用自己 `new` 的 ScrollView 实例、读私有的 `currentLayout` 用 `Reflect.get`，
  都不需要断言。）
- 升级 pi 前后，运行 `pnpm run test:compat`；失败时先看失败信息指出的是哪条假设：跳转相关的改 `src/jump.ts`，
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
