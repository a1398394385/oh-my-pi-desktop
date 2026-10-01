// omp 宿主薄入口（编译产物的主模块）。
//
// argv 分流：零参数 = 桌面宿主（Tauri 壳 spawn 时从不带参数），动态装载 main.ts；
// 非空 = 以 CLI 身份运行，交 SDK 的 runCli 分发。后者覆盖 `__omp_worker_*` 选择器：
// SDK 在编译形态下把 worker 子进程 re-entry 到当前可执行文件
// （worker-client.ts resolveWorkerSpawnCmd → [process.execPath, workerArg]），
// omp CLI 自身在 cli.ts 分发这些选择器，本产物若不分发，每个 worker 都会被
// 启动成完整桌面宿主——永不退出、各常驻 ~250MB；Windows 下 daemon broker 客户端
// 10s 连接超时后重试，每 10s 泄漏一个宿主进程（内存无限增长，BUG-026）。
//
// 分流必须在宿主静态图求值之前（ESM 静态 import 先于任何顶层代码执行），所以
// 宿主主体放 main.ts、worker 路径只动态拉取 CLI 轻入口（其静态图不含 TUI 与
// native addon 的运行时加载）。
// The GUI-launched host has a stripped PATH (nvm/Homebrew commands invisible):
// fire the PATH augment before loading the body (overlapping main.ts's static
// graph load incl. the SDK); main.ts awaits the same promise.
import { augmentGuiPath } from "./gui-path.ts";

const argv = process.argv.slice(2);
if (argv.length === 0) {
	augmentGuiPath();
	await import("./main.ts");
} else {
	const { declareWorkerHostEntry } = await import("@oh-my-pi/pi-utils/worker-host");
	// 对齐 CLI 进程入口（cli.ts isProcessEntry 分支）：本进程即分发入口，登记为
	// 合法 worker 宿主，使 worker 子进程（如 stats activity）能再 spawn worker 线程。
	declareWorkerHostEntry();
	const { runCli } = await import("@oh-my-pi/pi-coding-agent/cli");
	await runCli(argv);
	process.exit(0);
}
