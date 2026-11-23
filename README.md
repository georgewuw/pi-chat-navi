# pi-chat-navi

[pi coding agent](https://github.com/earendil-works/pi-coding-agent) 扩展：在 TUI 里用 `/questions` 打开「用户提问列表」浮动面板，点击即可跳回会话中的任意一次提问。

## 功能

- 面板停靠在右上角，列出当前会话分支上的所有用户提问（序号 + 时间 + 摘要）
- 鼠标点击条目，transcript 滚动到该提问处；滚轮翻动列表；顶部 `[ 关闭 ]` 关闭面板
- 键盘：↑↓ 选择，回车跳转，`q` / Esc 关闭
- 宽度：默认 60%。`/questions 50` 指定列数，`/questions 60%` 指定百分比。设置在会话内记忆；面板已打开时带参数会以新宽度重开

## 安装

```
pi install <本仓库路径或 git 地址>
```

开发时直接加载：`pi -ne -e .`

## 说明

跳转依赖 pi TUI 的内部布局对象和 transcript 里的 OSC 133;A 标记。pi 升级若改动这些内部实现，只有跳转会失效，面板本身不受影响。

## 许可

MIT
