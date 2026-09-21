//! Tauri 壳：只负责窗口、Bun 宿主进程的拉起与回收、把宿主 WS 地址转告前端。
//! 业务全部在 Bun 宿主进程里（host/host.ts，库内嵌 omp SDK）。

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

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

/// 前端调用：发送系统通知。
/// 参数（前端 camelCase 自动映射）：title / body / sessionId。
/// 限制：tauri-plugin-notification 的 Rust 侧在 macOS 上拿不到通知点击回调，
/// 点击通知只触发系统默认行为（聚焦本应用），因此无法在此 emit
/// "notification-click"；session_id 当前仅占位，若将来需要「点击切会话」，
/// 应改走插件 JS 侧的 onAction（JS 侧支持，但本项目前端不装 JS 包，故暂缺）。
#[tauri::command]
fn send_desktop_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
    session_id: String,
) -> Result<(), String> {
    let _ = session_id; // macOS 上无处使用，见函数注释
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| format!("发送通知失败: {e}"))
}

/// 构建原生应用菜单栏（macOS）。
/// 防双触发约束：所有「app 动作」项（新建会话/设置/缩放/主题/边栏）一律不绑
/// accelerator——前端 shell.js 已有 JS keydown 处理 ⌘N/⌘,/⌘±⌘0 等，菜单
/// accelerator 会与之叠加双触发；菜单点击统一 emit "menu-action" 交前端处理。
/// PredefinedMenuItem（复制/粘贴等）走系统响应链，自带系统快捷键，不受影响；
/// 且编辑菜单必须存在——macOS WKWebView 无菜单栏时 ⌘C/⌘V/⌘Z 等文本编辑
/// 快捷键行为不完整，这是顺带修复的真 bug。
fn build_menu(app: &tauri::App) -> tauri::Result<()> {
    // 应用菜单（macOS 第一栏）：关于 / 服务 / 隐藏 / 退出
    let app_menu = Submenu::with_items(
        app,
        "omp-desktop",
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    // 文件菜单：app 动作，无 accelerator
    let file_menu = Submenu::with_items(
        app,
        "文件",
        true,
        &[
            &MenuItem::with_id(app, "new-session", "新建会话", true, None::<&str>)?,
            &MenuItem::with_id(app, "open-settings", "打开设置", true, None::<&str>)?,
        ],
    )?;

    // 编辑菜单：全部预定义项，走系统响应链
    let edit_menu = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    // 视图菜单：全部 app 动作，无 accelerator
    let view_menu = Submenu::with_items(
        app,
        "视图",
        true,
        &[
            &MenuItem::with_id(app, "zoom-in", "放大", true, None::<&str>)?,
            &MenuItem::with_id(app, "zoom-out", "缩小", true, None::<&str>)?,
            &MenuItem::with_id(app, "zoom-reset", "重置缩放", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "toggle-theme", "切换深浅色主题", true, None::<&str>)?,
            &MenuItem::with_id(app, "toggle-sidebar", "切换边栏", true, None::<&str>)?,
        ],
    )?;

    // 窗口菜单：预定义项
    let window_menu = Submenu::with_items(
        app,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let menu = Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])?;
    app.set_menu(menu)?;

    // 菜单点击转发前端：payload 为 { action: <菜单项 id> }；PredefinedMenuItem
    // 不经过这里（直接走系统响应链）
    app.on_menu_event(|app, event| {
        let _ = app.emit("menu-action", serde_json::json!({ "action": event.id().0 }));
    });
    Ok(())
}

pub fn run() {
    let cell: WsUrlCell = Arc::new(Mutex::new(None));
    let child_cell: ChildCell = Arc::new(Mutex::new(None));
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // 只响应按下：松开会再触发一次，需过滤
                    if event.state == ShortcutState::Pressed {
                        // 全局唤起：还原最小化 → 显示 → 聚焦主窗口
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.unminimize();
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                })
                .build(),
        )
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
            // 原生菜单栏：编辑菜单的预定义项是 WKWebView 文本编辑快捷键生效的前提
            if let Err(e) = build_menu(app) {
                eprintln!("[shell] 构建菜单栏失败: {e}");
            }
            // 全局唤起快捷键 ⌘⇧M：被其他应用占用时不 panic，记日志跳过
            let summon = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyM);
            if let Err(e) = app.handle().global_shortcut().register(summon) {
                eprintln!("[shell] 注册全局唤起快捷键 ⌘⇧M 失败（可能被其他应用占用）: {e}");
            }
            spawn_host(cell.clone(), child_cell.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ws_url, send_desktop_notification])
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
