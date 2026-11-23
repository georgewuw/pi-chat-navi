/**
 * 兼容性矩阵：用指定版本的 pi 包跑 test/contract.test.mjs。
 *
 *   npm run test:compat                  # 测 latest
 *   npm run test:compat -- 1.6.0 latest  # 测多个版本（npm 版本号或 dist-tag）
 *
 * 每个版本在临时目录里独立安装 @earendil-works/pi-tui 与 pi-coding-agent，
 * 把 src/ 和契约测试复制过去运行，不改动本仓库的 node_modules。
 * 任何版本失败则退出码非 0。
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const versions = process.argv.slice(2);
if (versions.length === 0) versions.push("latest");

// 版本号会拼进 npm 命令行（Windows 下经 cmd.exe）：只允许精确版本号和 dist-tag，
// 不放行 < > ^ ~ * 等 shell 元字符或范围写法。
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
for (const v of versions) {
	if (!SAFE_VERSION.test(v)) {
		console.error(`Invalid version spec: ${v} (use an exact version like 1.6.0 or a dist-tag like latest)`);
		process.exit(2);
	}
}

const PACKAGES = ["@earendil-works/pi-tui", "@earendil-works/pi-coding-agent"];
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, cwd) {
	return spawnSync(command, args, { cwd, encoding: "utf8", shell: process.platform === "win32" });
}

const results = [];
for (const version of versions) {
	const dir = mkdtempSync(join(tmpdir(), "pi-chat-navi-compat-"));
	try {
		cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
		cpSync(join(root, "test", "contract.test.mjs"), join(dir, "test", "contract.test.mjs"));
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "compat", private: true, type: "module" }));

		const install = run(npm, ["install", "--no-audit", "--no-fund", "--ignore-scripts", ...PACKAGES.map((p) => `${p}@${version}`)], dir);
		if (install.status !== 0) {
			const message = install.error?.message ?? install.stderr ?? install.stdout ?? "";
			results.push({ version, status: "install-failed", detail: message.trim().split("\n").slice(-5).join("\n") });
			continue;
		}

		const installed = run(npm, ["ls", "--depth=0", "--json"], dir);
		let resolved = version;
		try {
			resolved = JSON.parse(installed.stdout).dependencies[PACKAGES[0]].version;
		} catch {
			// 取不到具体版本号时沿用输入
		}

		const test = run(process.execPath, ["--test", "test/contract.test.mjs"], dir);
		const output = `${test.stdout ?? ""}\n${test.stderr ?? ""}`;
		const failures = [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
		results.push({
			version: `${version} (pi-tui ${resolved})`,
			status: test.status === 0 ? "pass" : "fail",
			detail: failures.join("\n"),
			output: test.status === 0 ? "" : output,
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

let failed = false;
for (const r of results) {
	console.log(`${r.status === "pass" ? "PASS" : "FAIL"}  ${r.version}`);
	if (r.status !== "pass") {
		failed = true;
		if (r.detail) console.log(r.detail.replace(/^/gm, "      "));
		if (r.output) console.log(r.output.split("\n").filter((l) => /error:|^\s+(Q\d|.*不存在|.*找不到)/.test(l)).join("\n"));
	}
}
process.exit(failed ? 1 : 0);
