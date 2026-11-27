# Changelog

本项目的版本变更记录。Pi 在包升级后会读取本文件（`package.json` 的 `version` 增长时生效）。

## [0.1.2] - 未发布

### Changed

- 内部：测试改用 TypeScript（`test/*.test.ts`），并纳入 `pnpm run typecheck`；无功能变更。

## [0.1.0] - 2026-11-27

### Added

- `/questions` 命令：右上角浮动面板列出当前活动上下文里的用户提问，↑↓ 选择、回车跳转。
- 回合分析视图：→ 或 `d` 进入，展示思考、工具调用与输出；`t` 切换仅看思维链。
- 宽度记忆：`/questions 50`（列数）或 `/questions 60%`（百分比）。
- 跳转优先使用 transcript 的 OSC 133;A 标记，失败时退回文本匹配。
- 作为 npm 包直接发布 TypeScript 源码：`pi.extensions` 指向 `./src/index.ts`，pi 通过 jiti 加载，安装方无需构建。
- npm 包名使用 `@georgewuw/pi-chat-navi`，并设置 `publishConfig.access = "public"`。
- 契约测试与 `pnpm run test:compat` 版本矩阵，验证对 pi TUI 内部实现的假设。
- 开发与发布使用 pnpm，`packageManager` 固定版本，锁文件为 `pnpm-lock.yaml`。
