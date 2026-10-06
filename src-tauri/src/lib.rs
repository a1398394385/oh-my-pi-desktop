//! Tauri shell: only owns windows, spawning/reaping the Bun host process, and
//! relaying the host WS address to the frontend.
//! All business logic lives in the Bun host process (host/host.ts, in-repo omp SDK).

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

// Native menu bar is macOS-only: on Windows it renders as a white in-window
// menu strip, duplicating the custom-drawn title bar (ui-src/components/TitleBar.tsx)
// Menu/MenuItem are shared by the macOS menu bar and the tray menu below.
#[cfg(any(target_os = "windows", target_os = "macos"))]
use tauri::menu::{Menu, MenuItem};
#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadata, PredefinedMenuItem, Submenu};
#[cfg(target_os = "macos")]
use tauri::Emitter;
// System tray (Windows/macOS): makes the close-to-background state visible
// and reachable. Linux is skipped (libappindicator wiring not worth it).
#[cfg(any(target_os = "windows", target_os = "macos"))]
use tauri::tray::TrayIconBuilder;
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_window_state::{Builder as WindowStateBuilder, StateFlags};

struct HostState {
    url: Option<String>,
    error: Option<String>,
}

/// Host restart pacing gate: auto-restarts triggered by the memory-watchdog
/// exit code 86 must be rate-limited, so a "crashes right after launch" episode
/// cannot turn into an infinite restart loop.
#[derive(Default)]
struct RestartGate {
    last_restart: Option<std::time::Instant>,
    /// Count of fast restarts (<10s since the previous one); auto-restart stops after >3
    consecutive: u32,
}

type WsUrlCell = Arc<Mutex<HostState>>;
type ChildCell = Arc<Mutex<Option<Child>>>;
type RestartCell = Arc<Mutex<RestartGate>>;

/// GUI launches usually lack ~/.bun on PATH; probe common install locations first,
/// fall back to PATH otherwise.
fn resolve_bun() -> PathBuf {
    if cfg!(windows) {
        // Official installer location (%USERPROFILE%\.bun\bin\bun.exe); usually
        // only the user PATH references it, which a GUI-launched dev shell may
        // not inherit.
        if let Ok(home) = std::env::var("USERPROFILE") {
            let c = PathBuf::from(&home).join(".bun").join("bin").join("bun.exe");
            if c.is_file() {
                return c;
            }
        }
        return PathBuf::from("bun");
    }
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

/// Host launch command: packaged builds prefer the self-contained omp-host in the
/// resource dir (a `bun build --compile` artifact, independent of the source tree
/// and of bun on PATH); dev always runs the repo sources directly with bun —
/// in dev, resource_dir resolves to target/debug where a leftover packaged
/// omp-host.exe would let the sidecar branch match first and pin dev to stale
/// code, so the sidecar is only resolved in release builds.
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
            // host:build currently emits omp-host.exe uniformly; macOS can execute that Mach-O file directly.
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

/// Spawns the Bun host and watches its stdout for a first line `READY ws://...`.
/// Keeps draining stdout after the first line (to avoid a full pipe); the child
/// handle goes into ChildCell and is explicitly killed on shell exit
/// (RunEvent::Exit) so the host never becomes an orphan process.
/// On stdout EOF (host exit) the child is reaped via wait; exit code 86 (host
/// memory watchdog, host/main.ts kills itself on RSS overrun) restarts the host
/// through RestartGate with rate limiting — the frontend retry loop picks up the
/// new WS port and reconnects automatically, disk sessions are unaffected.
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
    // On Windows the shell is a GUI-subsystem app (no console); inheriting stderr
    // would open a new black console window for bun. Pipe stderr + CREATE_NO_WINDOW
    // instead, with a thread draining and forwarding the logs
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
        // stdout EOF = host has exited: reap via wait (nothing waited before, leaving a zombie until the shell itself exited)
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
        // 86 = host memory-watchdog self-kill (host/main.ts RSS over 2GB): rate-limited
        // restart; the frontend retry loop reconnects to the new port automatically,
        // user disk sessions unaffected
        if exit_code == Some(86) {
            let mut gate = reader_restart_cell.lock().unwrap();
            let now = std::time::Instant::now();
            // A stable run of >=5min means a new failure episode: reset the streak counter
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
                // Old port is dead: clear url so the frontend ws_url polling waits for the new host's READY
                let mut state = reader_cell.lock().unwrap();
                state.url = None;
            }
            eprintln!("[shell] 宿主因内存超限退出，自动重启");
            spawn_host(&reader_app, reader_cell, reader_child_cell, reader_restart_cell);
        }
    });
}

/// Called by the frontend at startup: waits for the host to be ready and returns the WS URL.
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

/// Frontend call: send a system notification.
/// Args (frontend camelCase auto-mapped): title / body / sessionId.
/// Limitation: the Rust side of tauri-plugin-notification cannot get the
/// notification-click callback on macOS — clicking only triggers the system
/// default behavior (focusing this app), so "notification-click" cannot be
/// emitted here; session_id is currently a placeholder. If "click to switch
/// session" is ever needed, switch to the plugin's JS-side onAction (supported
/// there, but this project's frontend doesn't bundle the JS package, so it is absent for now).
#[tauri::command]
fn send_desktop_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
    session_id: String,
) -> Result<(), String> {
    let _ = session_id; // unused on macOS, see the doc comment above
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| format!("notify-failed: {e}"))
}

/// Builds the native app menu bar (macOS).
/// Anti-double-trigger constraint: no "app action" item (new session/settings/
/// zoom/theme/sidebar) ever binds an accelerator — the frontend shell.js already
/// handles ⌘N/⌘,/⌘±⌘0 etc. via JS keydown, and a menu accelerator would stack
/// into a double trigger; menu clicks uniformly emit "menu-action" and are
/// handled by the frontend.
/// PredefinedMenuItems (copy/paste etc.) go through the system responder chain
/// with their own system shortcuts and are unaffected; the edit menu must also
/// exist — without a menu bar, macOS WKWebView text-edit shortcuts like
/// ⌘C/⌘V/⌘Z behave incompletely, which this incidentally fixes for real.
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
    // App menu (first macOS menu): About / Services / Hide / Quit
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

    // File menu: app actions, no accelerators
    let file_menu = Submenu::with_items(
        app,
        l.file,
        true,
        &[
            &MenuItem::with_id(app, "new-session", l.new_session, true, None::<&str>)?,
            &MenuItem::with_id(app, "open-settings", l.open_settings, true, None::<&str>)?,
        ],
    )?;

    // Edit menu: all predefined items, through the system responder chain
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

    // View menu: all app actions, no accelerators
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

    // Window menu: predefined items
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

/// Bring the main window back from hidden/minimized state and focus it.
/// Shared by the tray icon, the single-instance relaunch callback, and the
/// macOS Dock reopen event.
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Tray menu labels — same static two-language table approach as the macOS
/// menu bar labels (zh-CN fallback keeps the pre-invoke startup default).
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn tray_labels(lang: &str) -> (String, String) {
    match lang {
        "en" => ("Show Main Window".into(), "Quit".into()),
        _ => ("显示主窗口".into(), "退出".into()),
    }
}

/// Build the locale-dependent tray menu (show / quit items).
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn tray_menu(app: &tauri::AppHandle, lang: &str) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let (show_label, quit_label) = tray_labels(lang);
    let show = MenuItem::with_id(app, "tray_show", show_label, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray_quit", quit_label, true, None::<&str>)?;
    Menu::with_items(app, &[&show, &quit])
}

/// System tray icon. The window close button only hides the window (the Bun
/// host and its workers keep running by design — agents continue in the
/// background); the tray keeps that state discoverable and recoverable:
/// Windows left-click (or the menu item) reopens the window, macOS opens the
/// menu on click, and the menu's Quit is the only real full exit on Windows.
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn build_tray(app: &tauri::AppHandle, lang: &str) -> tauri::Result<()> {
    let menu = tray_menu(app, lang)?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("omp desktop")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().0.as_str() {
            "tray_show" => show_main_window(app),
            "tray_quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    // Windows convention: plain left click reopens the window, the menu stays
    // on right click. On macOS a tray click opens the menu itself (default
    // show_menu_on_left_click), so the show action lives in the menu item only.
    #[cfg(target_os = "windows")]
    {
        builder = builder
            .show_menu_on_left_click(false)
            .on_tray_icon_event(|tray, event| {
                if matches!(
                    event,
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                ) {
                    show_main_window(tray.app_handle());
                }
            });
    }
    builder.build(app)?;
    Ok(())
}

/// Frontend call (startup + language switch): rebuild the native menu bar and
/// the tray menu with the given locale ("zh-CN"/"en"). Registered on every
/// platform; only macOS renders a menu bar, Windows/macOS carry the tray,
/// elsewhere it's a no-op.
#[tauri::command]
fn set_menu_language(app: tauri::AppHandle, lang: String) -> Result<(), String> {
    if lang != "zh-CN" && lang != "en" {
        return Err(format!("set_menu_language: unsupported lang {lang}"));
    }
    #[cfg(target_os = "macos")]
    build_menu(&app, &lang).map_err(|e| e.to_string())?;
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        let menu = tray_menu(&app, &lang).map_err(|e| e.to_string())?;
        if let Some(tray) = app.tray_by_id("main") {
            tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = (&app, &lang);
    Ok(())
}

pub fn run() {
    let cell: WsUrlCell = Arc::new(Mutex::new(HostState {
        url: None,
        error: None,
    }));
    let child_cell: ChildCell = Arc::new(Mutex::new(None));
    let restart_cell: RestartCell = Arc::new(Mutex::new(RestartGate::default()));
    tauri::Builder::default()
        // Single-instance lock MUST be the first registered plugin: a relaunch
        // (Start Menu / shortcut / `open`) focuses the existing window instead
        // of spawning a whole new process tree (desktop + host + brokers +
        // workers) — the hidden close-to-background instances used to
        // accumulate unbounded otherwise.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        // Window geometry memory: save size/position/maximized on exit and restore on
        // launch (auto via on_window_ready, before the app setup hook below runs).
        // Flags deliberately exclude VISIBLE/DECORATIONS/FULLSCREEN: visibility is owned
        // by the setup hook (config visible:false prevents pre-restore geometry flash),
        // decorations differ per platform config, fullscreen is not a per-launch state
        // this app wants to silently re-enter.
        .plugin(
            WindowStateBuilder::new()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        // Close-to-background: red X / ⌘W only hides the window — the Bun host
        // and its workers keep running (agents continue in the background, the
        // same semantics as other desktop agents). The tray icon keeps that
        // hidden state discoverable and recoverable; a relaunch focuses the
        // existing window via the single-instance plugin; real exit stays on
        // ⌘Q / the app-menu Quit item / the tray menu Quit.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .manage(cell.clone())
        .manage(child_cell.clone())
        .setup(move |app| {
            // Window becomes visible here, after the window-state plugin has restored
            // the saved geometry (config visible:false hides the pre-restore flash of
            // the default 1280x820 frame). No manual reset anymore — geometry persists.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
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
            // System tray: built with the zh-CN default, aligned with the
            // persisted language by the frontend's set_menu_language call.
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            if let Err(e) = build_tray(app.handle(), "zh-CN") {
                eprintln!("[shell] 构建托盘失败: {e}");
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
            match event {
                tauri::RunEvent::Exit => {
                    if let Some(mut child) = app.state::<ChildCell>().inner().lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
                // macOS Dock icon click with all windows hidden (close was intercepted
                // into hide above): bring the main window back to the front.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { has_visible_windows: false, .. } => {
                    show_main_window(app.app_handle());
                }
                _ => {}
            }
        });
}
