/**
 * 仓库根入口：只加载 TUI 提问面板（/questions）。
 * 开发加载：`pi -ne -e .`
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import questionPanel from "./question-panel";

export default function (pi: ExtensionAPI): void {
	questionPanel(pi);
}
