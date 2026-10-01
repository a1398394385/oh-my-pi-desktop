//! Tauri 壳：只负责窗口、Bun 宿主进程的拉起与回收、把宿主 WS 地址转告前端。
//! 业务全部在 Bun 宿主进程里（host/host.ts，库内嵌 omp SDK）。

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

// 原生菜单栏仅 macOS 构建：Windows 上会渲染成窗口内白色菜单条，
// 与自绘标题栏（ui-src/components/TitleBar.tsx）重复
#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

struct HostState {
    url: Option<String>,
    error: Option<String>,
}

/// 宿主重启节奏门：内存看门狗退出码 86 触发的自动重启须限频，
/// 防「启动即失控」场景变成无限重启循环。
#[derive(Default)]
struct RestartGate {
    last_restart: Option<std::time::Instant>,
    /// 距上次重启 <10s 的快速重启连击数，>3 次停止自动重启
    consecutive: u32,
}

type WsUrlCell = Arc<Mutex<HostState>>;
type ChildCell = Arc<Mutex<Option<Child>>>;
type RestartCell = Arc<Mutex<RestartGate>>;

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

/// 宿主启动命令：打包形态优先资源目录里的自包含 omp-host（bun build --compile
/// 产物，不依赖源码树与 PATH 里的 bun）；dev 形态一律 bun 直跑仓库源码——
/// dev 下 resource_dir 解析到 target/debug，其中残留的打包产物 omp-host.exe
/// 会让 sidecar 分支抢先命中，dev 永远跑固化旧代码，故 sidecar 仅 release 解析。
fn host_command(app: &tauri::AppHandle) -> Result<Command, String> {
    if !cfg!(debug_assertions) {
        let resource_dir = app
            .path()
            .resource_dir()
            // Stable error-code prefix; the frontend maps it to a translated message.
            .map_err(|e| format!("asset-dir-failed: {e}"))?;
        let names: &[&str] = if cfg!(windows) {
            &["omp-host.exe", "omp-host"]
        } else {
            // 当前 host:build 统一输出 omp-host.exe；macOS 也可直接执行该 Mach-O 文件。
            &["omp-host", "omp-host.exe"]
        };
        for name in names {
            let host = resource_dir.join(name);
            if host.is_file() {
                return Ok(Command::new(host));
            }
        }
        // Dynamic detail is the resource dir path itself (code prefix carries the meaning).
        return Err(format!("host-sidecar-missing: {}", resource_dir.display()));
    }

    let mut cmd = Command::new(resolve_bun());
    cmd.arg(concat!(env!("CARGO_MANIFEST_DIR"), "/../host/host.ts"));
    Ok(cmd)
}

/// 拉起 Bun 宿主并监听其 stdout 首行 `READY ws://...`。
/// 首行之后继续读完 stdout（防管道写满）；子进程句柄存 ChildCell，
/// 壳退出（RunEvent::Exit）时显式 kill，避免宿主变孤儿进程。
/// stdout EOF（宿主退出）时 wait 回收子进程；若退出码为 86（宿主内存看门狗，
/// host/main.ts RSS 超限自杀）则经 RestartGate 限频重启宿主——前端重试环会
/// 自动拿到新 WS 端口恢复连接，磁盘会话不受影响。
fn spawn_host(
    app: &tauri::AppHandle,
    cell: WsUrlCell,
    child_cell: ChildCell,
    restart_cell: RestartCell,
) {
    let mut cmd = match host_command(app) {
        Ok(cmd) => cmd,
        Err(message) => {
            eprintln!("[shell] {message}");
            cell.lock().unwrap().error = Some(message);
            return;
        }
    };
    cmd.stdout(Stdio::piped());
    // Windows 上壳是 GUI 子系统（无控制台），stderr inherit 会给 bun 新开
    // 一个控制台黑窗；改为管道 + CREATE_NO_WINDOW，由线程排空透传日志
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.stderr(Stdio::piped()).creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(target_os = "windows"))]
    {
        cmd.stderr(Stdio::inherit());
    }
    let mut child: Child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            let message = format!("host-spawn-failed: {e}");
            eprintln!("[shell] {message}");
            cell.lock().unwrap().error = Some(message);
            return;
        }
    };
    let stdout = child.stdout.take().expect("stdout 已 piped");
    #[cfg(target_os = "windows")]
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[host] {line}");
            }
        });
    }
    *child_cell.lock().unwrap() = Some(child);
    let reader_cell = cell.clone();
    let reader_child_cell = child_cell.clone();
    let reader_restart_cell = restart_cell.clone();
    let reader_app = app.clone();
    std::thread::spawn(move || {
        let mut ready = false;
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(l) => {
                    if let Some(url) = l.strip_prefix("READY ") {
                        reader_cell.lock().unwrap().url = Some(url.trim().to_string());
                        ready = true;
                    }
                }
                Err(_) => break,
            }
        }
        // stdout EOF = 宿主已退出：wait 回收（原先无人 wait，退出后留僵尸到壳自身退出）
        let exit_code = reader_child_cell
            .lock()
            .unwrap()
            .take()
            .and_then(|mut c| c.wait().ok())
            .and_then(|status| status.code());
        if !ready {
            let mut state = reader_cell.lock().unwrap();
            if state.error.is_none() {
                state.error = Some("host-exit-early".into());
            }
            return;
        }
        // 86 = 宿主内存看门狗自杀（host/main.ts RSS 超 2GB）：限频重启，
        // 前端重试环自动接入新端口，用户磁盘会话不受影响
        if exit_code == Some(86) {
            let mut gate = reader_restart_cell.lock().unwrap();
            let now = std::time::Instant::now();
            // 曾稳定运行 ≥5min 视为新一轮失控，清零连击计数
            if gate
                .last_restart
                .is_some_and(|t| now.duration_since(t) >= Duration::from_secs(300))
            {
                gate.consecutive = 0;
            }
            if gate
                .last_restart
                .is_some_and(|t| now.duration_since(t) < Duration::from_secs(10))
            {
                gate.consecutive += 1;
            }
            if gate.consecutive > 3 {
                drop(gate);
                let mut state = reader_cell.lock().unwrap();
                state.url = None;
                state.error = Some("host-restart-stopped".into());
                return;
            }
            gate.last_restart = Some(now);
            drop(gate);
            {
                // 旧端口已死：清 url，前端 ws_url 轮询等新宿主的 READY
                let mut state = reader_cell.lock().unwrap();
                state.url = None;
            }
            eprintln!("[shell] 宿主因内存超限退出，自动重启");
            spawn_host(&reader_app, reader_cell, reader_child_cell, reader_restart_cell);
        }
    });
}

/// 前端启动时调用，等宿主就绪并返回 WS 地址。
#[tauri::command]
fn ws_url(cell: tauri::State<WsUrlCell>) -> Result<String, String> {
    for _ in 0..600 {
        let state = cell.lock().unwrap();
        if let Some(error) = state.error.clone() {
            return Err(error);
        }
        if let Some(u) = state.url.clone() {
            return Ok(u);
        }
        drop(state);
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("host-not-ready".into())
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
        .map_err(|e| format!("notify-failed: {e}"))
}

/// 构建原生应用菜单栏（macOS）。
/// 防双触发约束：所有「app 动作」项（新建会话/设置/缩放/主题/边栏）一律不绑
/// accelerator——前端 shell.js 已有 JS keydown 处理 ⌘N/⌘,/⌘±⌘0 等，菜单
/// accelerator 会与之叠加双触发；菜单点击统一 emit "menu-action" 交前端处理。
/// PredefinedMenuItem（复制/粘贴等）走系统响应链，自带系统快捷键，不受影响；
/// 且编辑菜单必须存在——macOS WKWebView 无菜单栏时 ⌘C/⌘V/⌘Z 等文本编辑
/// 快捷键行为不完整，这是顺带修复的真 bug。
/// Locale-dependent labels for the native menu bar. Menu item ids stay fixed —
/// the frontend "menu-action" dispatch depends on them, only labels change.
#[cfg(target_os = "macos")]
struct MenuLabels {
    file: &'static str,
    new_session: &'static str,
    open_settings: &'static str,
    edit: &'static str,
    view: &'static str,
    zoom_in: &'static str,
    zoom_out: &'static str,
    zoom_reset: &'static str,
    toggle_theme: &'static str,
    toggle_sidebar: &'static str,
    window: &'static str,
}

/// Static two-language table (no i18n framework for a 2 x 11 set).
/// zh-CN is the fallback so the pre-invoke startup default stays Chinese.
#[cfg(target_os = "macos")]
fn menu_labels(lang: &str) -> MenuLabels {
    match lang {
        "en" => MenuLabels {
            file: "File",
            new_session: "New Session",
            open_settings: "Open Settings",
            edit: "Edit",
            view: "View",
            zoom_in: "Zoom In",
            zoom_out: "Zoom Out",
            zoom_reset: "Reset Zoom",
            toggle_theme: "Toggle Light/Dark Theme",
            toggle_sidebar: "Toggle Sidebar",
            window: "Window",
        },
        _ => MenuLabels {
            file: "文件",
            new_session: "新建会话",
            open_settings: "打开设置",
            edit: "编辑",
            view: "视图",
            zoom_in: "放大",
            zoom_out: "缩小",
            zoom_reset: "重置缩放",
            toggle_theme: "切换深浅色主题",
            toggle_sidebar: "切换边栏",
            window: "窗口",
        },
    }
}

#[cfg(target_os = "macos")]
fn build_menu(app: &tauri::AppHandle, lang: &str) -> tauri::Result<()> {
    let l = menu_labels(lang);
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
        l.file,
        true,
        &[
            &MenuItem::with_id(app, "new-session", l.new_session, true, None::<&str>)?,
            &MenuItem::with_id(app, "open-settings", l.open_settings, true, None::<&str>)?,
        ],
    )?;

    // 编辑菜单：全部预定义项，走系统响应链
    let edit_menu = Submenu::with_items(
        app,
        l.edit,
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
        l.view,
        true,
        &[
            &MenuItem::with_id(app, "zoom-in", l.zoom_in, true, None::<&str>)?,
            &MenuItem::with_id(app, "zoom-out", l.zoom_out, true, None::<&str>)?,
            &MenuItem::with_id(app, "zoom-reset", l.zoom_reset, true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "toggle-theme", l.toggle_theme, true, None::<&str>)?,
            &MenuItem::with_id(app, "toggle-sidebar", l.toggle_sidebar, true, None::<&str>)?,
        ],
    )?;

    // 窗口菜单：预定义项
    let window_menu = Submenu::with_items(
        app,
        l.window,
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let menu = Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu],
    )?;
    app.set_menu(menu)?;
    Ok(())
}

/// Frontend call (startup + language switch): rebuild the native menu bar
/// with the given locale ("zh-CN"/"en"). Registered on every platform, but
/// only macOS renders a menu bar (see build_menu) — elsewhere it's a no-op.
#[tauri::command]
fn set_menu_language(app: tauri::AppHandle, lang: String) -> Result<(), String> {
    if lang != "zh-CN" && lang != "en" {
        return Err(format!("set_menu_language: unsupported lang {lang}"));
    }
    #[cfg(target_os = "macos")]
    {
        build_menu(&app, &lang).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&app, &lang);
        Ok(())
    }
}

pub fn run() {
    let cell: WsUrlCell = Arc::new(Mutex::new(HostState {
        url: None,
        error: None,
    }));
    let child_cell: ChildCell = Arc::new(Mutex::new(None));
    let restart_cell: RestartCell = Arc::new(Mutex::new(RestartGate::default()));
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
            // Native menu bar: the edit submenu's predefined items are required
            // for WKWebView text-edit shortcuts. Default zh-CN here; the frontend
            // invokes set_menu_language on startup to align with the user's
            // persisted language.
            #[cfg(target_os = "macos")]
            {
                if let Err(e) = build_menu(app.handle(), "zh-CN") {
                    eprintln!("[shell] 构建菜单栏失败: {e}");
                }
                // Forward menu clicks to the frontend: payload is
                // { action: <menu item id> }; PredefinedMenuItem never passes
                // here (system responder chain). Registered once outside
                // build_menu so menu rebuilds don't stack duplicate handlers.
                app.on_menu_event(|app, event| {
                    let _ = app.emit("menu-action", serde_json::json!({ "action": event.id().0 }));
                });
            }
            // 全局唤起快捷键：Windows 用 Ctrl+Shift+M（Win 键被系统占用过多），
            // macOS 用 ⌘⇧M；被其他应用占用时不 panic，记日志跳过
            #[cfg(target_os = "windows")]
            let summon = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyM);
            #[cfg(not(target_os = "windows"))]
            let summon = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyM);
            if let Err(e) = app.handle().global_shortcut().register(summon) {
                eprintln!("[shell] 注册全局唤起快捷键失败（可能被其他应用占用）: {e}");
            }
            spawn_host(app.handle(), cell.clone(), child_cell.clone(), restart_cell.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ws_url,
            send_desktop_notification,
            set_menu_language
        ])
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
