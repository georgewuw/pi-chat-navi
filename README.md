# pi-chat-navi

[pi coding agent](https://github.com/earendil-works/pi-coding-agent) 扩展：在 TUI 里用 `/questions` 打开「用户提问列表」浮动面板，点击即可跳回会话中的任意一次提问。

## 功能

- 面板停靠在右上角，列出**当前 transcript 实际显示**的用户提问（序号 + 摘要）；被压缩掉的旧提问不会出现
- 鼠标仅支持回合分析详情区的滚轮（详情区右侧显示滚动条）；单击/双击/悬停均无效果
- 键盘：↑↓ 选择，回车跳转（作用于当前选中项），Esc 关闭（回合分析内 Esc 先返回列表）
- 宽度：默认 60%。`/questions 50` 指定列数，`/questions 60%` 指定百分比。设置在会话内记忆；面板已打开时带参数会以新宽度重开

## 安装

```
pi install <本仓库路径或 git 地址>
```

开发时直接加载：`pi -ne -e .`

## 测试

```
npm test        # 等价于 node --test，仅测 question-logic.ts 的纯函数
```

## 说明

- 列表与标记序号基于 `sessionManager.buildContextEntries()`（压缩后的活动上下文），与 transcript 渲染一致；纯图片/空白的用户消息不会渲染组件，会被跳过。
- 跳转优先使用 transcript 里的 OSC 133;A 标记定位；标记失效（pi 改动标记规则）时自动退回文本匹配（遍历 `UserMessageComponent`，按归一化文本 + 渲染首行出现序定位）。
- 跳转仍依赖 pi TUI 的内部布局对象；pi 升级若改动这些内部实现，只有跳转会失效（会提示），面板本身不受影响。

## 许可

MIT
