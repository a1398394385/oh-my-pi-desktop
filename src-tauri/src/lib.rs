//! Tauri 壳：只负责窗口、Bun 宿主进程的拉起与回收、把宿主 WS 地址转告前端。
//! 业务全部在 Bun 宿主进程里（host/host.ts，库内嵌 omp SDK）。

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Manager;

type WsUrlCell = Arc<Mutex<Option<String>>>;
type ChildCell = Arc<Mutex<Option<Child>>>;

/// GUI 启动时 PATH 通常不含 ~/.bun，按常见安装位置探测，找不到再交给 PATH。
fn resolve_bun() -> PathBuf {
    if let Ok(home) = std::env::var("HOME") {
        let candidates = [
            PathBuf::from(&home).join(".bun/bin/bun"),
            PathBuf::from("/Volumes/MacApps/Home/.bun/bin/bun"),
            PathBuf::from("/opt/homebrew/bin/bun"),
            PathBuf::from("/usr/local/bin/bun"),
        ];
        for c in candidates {
            if c.is_file() {
                return c;
            }
        }
    }
    PathBuf::from("bun")
}

/// 拉起 Bun 宿主并监听其 stdout 首行 `READY ws://...`。
/// 首行之后继续读完 stdout（防管道写满）；子进程句柄存 ChildCell，
/// 壳退出（RunEvent::Exit）时显式 kill，避免宿主变孤儿进程。
fn spawn_host(cell: WsUrlCell, child_cell: ChildCell) {
    // 编译期锚定仓库内的宿主脚本；MVP 只支持 dev 形态（打包需 sidecar，后置）
    let host_ts = concat!(env!("CARGO_MANIFEST_DIR"), "/../host/host.ts");
    let mut child: Child = Command::new(resolve_bun())
        .arg(host_ts)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("启动 bun 宿主失败（bun 是否安装？）");
    let stdout = child.stdout.take().expect("stdout 已 piped");
    *child_cell.lock().unwrap() = Some(child);
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(l) => {
                    if let Some(url) = l.strip_prefix("READY ") {
                        *cell.lock().unwrap() = Some(url.trim().to_string());
                    }
                }
                Err(_) => break,
            }
        }
    });
}

/// 前端启动时调用，等宿主就绪并返回 WS 地址。
#[tauri::command]
fn ws_url(cell: tauri::State<WsUrlCell>) -> Result<String, String> {
    for _ in 0..150 {
        if let Some(u) = cell.lock().unwrap().clone() {
            return Ok(u);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("宿主进程 15s 内未就绪，查看终端日志定位".into())
}

pub fn run() {
    let cell: WsUrlCell = Arc::new(Mutex::new(None));
    let child_cell: ChildCell = Arc::new(Mutex::new(None));
    tauri::Builder::default()
        .manage(cell.clone())
        .manage(child_cell.clone())
        .setup(move |app| {
            // 窗口启动复位：macOS 会残留上次的迷你/屏外 frame（多 dev 实例与用户缩窗叠加），
            // 显式拉回主屏固定位置，保证窗口可见可测
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                if let Err(e) = win.set_position(tauri::LogicalPosition::new(300.0, 130.0)) {
                    eprintln!("[shell] set_position 失败: {e}");
                }
                if let Err(e) = win.set_size(tauri::LogicalSize::new(1280.0, 820.0)) {
                    eprintln!("[shell] set_size 失败: {e}");
                }
                let _ = win.show();
                let _ = win.set_focus();
            }
            spawn_host(cell.clone(), child_cell.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ws_url])
        .build(tauri::generate_context!())
        .expect("tauri 构建失败")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(mut child) = app.state::<ChildCell>().inner().lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
