/**
 * 兼容性矩阵：用指定版本的 pi 包跑 test/contract.test.ts。
 *
 *   pnpm run test:compat                     # 测 latest
 *   pnpm run test:compat -- 1.6.0 latest     # 测多个版本（npm 上发布的版本号或 dist-tag）
 *   pnpm run test:compat -- --keep 1.6.0     # 保留临时目录，便于排查
 *   pnpm run test:compat -- --verbose 1.6.0  # 失败时打印完整测试输出
 *
 * 每个版本在临时目录里独立安装 @earendil-works/pi-tui 与 pi-coding-agent，
 * 把 src/ 和契约测试复制过去运行，不改动本仓库的 node_modules。
 *
 * 环境变量：
 *   PI_COMPAT_KEEP=1     等价于 --keep
 *   PI_COMPAT_VERBOSE=1  等价于 --verbose
 *
 * 任何版本失败则退出码非 0；参数/环境错误退出码 2。
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_TEST = join("test", "contract.test.ts");
const PACKAGES = ["@earendil-works/pi-tui", "@earendil-works/pi-coding-agent"];
const IS_WINDOWS = process.platform === "win32";
const PACKAGE_MANAGER = IS_WINDOWS ? "pnpm.cmd" : "pnpm";
const FIXTURE_PREFIX = "pi-chat-navi-compat-";
const MAX_OUTPUT_LINES = 120;

// 版本号会拼进 pnpm 命令行（Windows 下经 cmd.exe）：只允许精确版本号和 dist-tag，
// 不放行 < > ^ ~ * 等 shell 元字符或范围写法。
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const USAGE = `Usage: pnpm run test:compat -- [options] [version...]

Arguments:
  version       npm 上发布的 pi 版本号或 dist-tag，默认 latest

Options:
  --keep       保留临时目录（失败排查用）
  --verbose    失败时打印完整测试输出
  -h, --help   显示本帮助

Environment:
  PI_COMPAT_KEEP=1     等价于 --keep
  PI_COMPAT_VERBOSE=1  等价于 --verbose`;

function parseArgs(argv) {
	const versions = [];
	const options = {
		keep: process.env.PI_COMPAT_KEEP === "1",
		verbose: process.env.PI_COMPAT_VERBOSE === "1",
	};

	for (const arg of argv) {
		// pnpm 会把分隔符 `--` 也传给脚本，npm 会吃掉它；两种都兼容。
		if (arg === "--") continue;
		if (arg === "-h" || arg === "--help") return { help: true };
		if (arg === "--keep") {
			options.keep = true;
			continue;
		}
		if (arg === "--verbose") {
			options.verbose = true;
			continue;
		}
		if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
		if (!SAFE_VERSION.test(arg)) {
			throw new Error(`Invalid version spec: ${arg} (use an exact version like 1.6.0 or a dist-tag like latest)`);
		}
		versions.push(arg);
	}

	if (versions.length === 0) versions.push("latest");
	return { help: false, versions, ...options };
}

/**
 * 统一执行外部命令。Windows 下 pnpm 是 .cmd，必须经过 shell；
 * node 可执行文件直接 spawn，避免路径中的空格/元字符被 shell 解释。
 */
function run(command, args, cwd, { shell = false } = {}) {
	return spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		shell,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function runPackageManager(args, cwd) {
	return run(PACKAGE_MANAGER, args, cwd, { shell: IS_WINDOWS });
}

function runNode(args, cwd) {
	return run(process.execPath, args, cwd);
}

function commandOutput(result) {
	const parts = [];
	if (result.error) parts.push(result.error.message);
	if (result.stdout?.trim()) parts.push(result.stdout.trim());
	if (result.stderr?.trim()) parts.push(result.stderr.trim());
	return parts.join("\n");
}

function lastLines(text, count) {
	const lines = text.split(/\r?\n/).filter((line, index, all) => line !== "" || index < all.length - 1);
	return lines.slice(-count).join("\n");
}

function createFixture() {
	const dir = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
	cpSync(join(ROOT, "src"), join(dir, "src"), { recursive: true });
	mkdirSync(join(dir, "test"), { recursive: true });
	cpSync(join(ROOT, CONTRACT_TEST), join(dir, CONTRACT_TEST));
	writeFileSync(
		join(dir, "package.json"),
		`${JSON.stringify({ name: "pi-chat-navi-compat", private: true, type: "module" }, null, 2)}\n`,
	);
	return dir;
}

function installPiPackages(dir, version) {
	// --ignore-workspace：临时目录若恰好位于某个 workspace 下也按独立项目安装
	// --no-frozen-lockfile：允许本次安装写入刚创建的 package.json
	return runPackageManager(
		[
			"install",
			"--ignore-scripts",
			"--ignore-workspace",
			"--no-frozen-lockfile",
			...PACKAGES.map((pkg) => `${pkg}@${version}`),
		],
		dir,
	);
}

/** 直接读安装后的 package.json，避开 npm/pnpm `ls --json` 的输出结构差异。 */
function installedVersion(dir, pkg) {
	try {
		const manifest = JSON.parse(readFileSync(join(dir, "node_modules", pkg, "package.json"), "utf8"));
		return typeof manifest.version === "string" ? manifest.version : undefined;
	} catch {
		return undefined;
	}
}

function runContractTest(dir) {
	const result = runNode(["--test", CONTRACT_TEST], dir);
	const output = commandOutput(result);
	const failures = [...output.matchAll(/^not ok \d+ - (.+?)(?: # .*)?$/gm)].map((match) => match[1]);
	return { ok: result.status === 0, failures, output };
}

function testVersion(version, options) {
	const dir = createFixture();
	try {
		const install = installPiPackages(dir, version);
		if (install.status !== 0) {
			return {
				version,
				status: "install-failed",
				detail: lastLines(commandOutput(install), 12),
			};
		}

		const resolved = {
			tui: installedVersion(dir, PACKAGES[0]),
			codingAgent: installedVersion(dir, PACKAGES[1]),
		};
		const test = runContractTest(dir);
		return {
			version,
			status: test.ok ? "pass" : "test-failed",
			resolved,
			detail: test.failures.join("\n"),
			output: test.ok ? "" : test.output,
		};
	} finally {
		if (options.keep) {
			console.error(`Kept fixture: ${dir}`);
		} else {
			rmSync(dir, { recursive: true, force: true });
		}
	}
}

function formatLabel(result) {
	const { tui, codingAgent } = result.resolved ?? {};
	const details = [];
	if (tui) details.push(`pi-tui ${tui}`);
	if (codingAgent && codingAgent !== tui) details.push(`pi-coding-agent ${codingAgent}`);
	return details.length > 0 ? `${result.version} (${details.join(", ")})` : result.version;
}

function printIndented(text, prefix = "      ") {
	if (!text) return;
	console.log(
		text
			.split(/\r?\n/)
			.map((line) => `${prefix}${line}`)
			.join("\n"),
	);
}

function reportResult(result, options) {
	if (result.status === "pass") {
		console.log(`PASS  ${formatLabel(result)}`);
		return;
	}

	console.log(`FAIL  ${formatLabel(result)} [${result.status}]`);
	if (result.detail) printIndented(result.detail);
	if (!result.output) return;

	const lines = result.output.split(/\r?\n/);
	const shown = options.verbose ? lines : lines.slice(-MAX_OUTPUT_LINES);
	if (!options.verbose && lines.length > shown.length) {
		console.log(`      ... (${lines.length - shown.length} lines omitted; use --verbose for full output)`);
	}
	printIndented(shown.join("\n"));
}

function main() {
	let options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		console.error(USAGE);
		return 2;
	}

	if (options.help) {
		console.log(USAGE);
		return 0;
	}

	const probe = runPackageManager(["--version"], ROOT);
	if (probe.status !== 0) {
		console.error("Cannot run pnpm. Install it (for example: corepack enable) and retry.");
		const detail = lastLines(commandOutput(probe), 5);
		if (detail) console.error(detail);
		return 2;
	}

	const pnpmVersion = (probe.stdout ?? "").trim();
	const results = options.versions.map((version) => {
		try {
			return testVersion(version, options);
		} catch (error) {
			return {
				version,
				status: "error",
				detail: error instanceof Error ? error.message : String(error),
			};
		}
	});
	for (const result of results) reportResult(result, options);

	const failed = results.filter((result) => result.status !== "pass").length;
	const passed = results.length - failed;
	console.log(`\n${passed} passed, ${failed} failed (pnpm ${pnpmVersion})`);
	return failed === 0 ? 0 : 1;
}

process.exitCode = main();
