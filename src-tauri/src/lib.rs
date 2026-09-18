mod commands;
mod omp;
mod protocol;
mod sessions;

use omp::SessionManager;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .manage(SessionManager::default())
        .invoke_handler(tauri::generate_handler![
            commands::omp_spawn,
            commands::omp_request,
            commands::omp_ui_response,
            commands::omp_close,
            commands::omp_stderr,
            commands::omp_list_sessions,
        ])
        .build(tauri::generate_context!())
        .expect("tauri 初始化失败")
        .run(|app, event| {
            // 退出前串行优雅关闭所有 omp 子进程（关 stdin → 等退出 → 超时 kill）
            if let tauri::RunEvent::Exit = event {
                let mgr: tauri::State<SessionManager> = app.state();
                tauri::async_runtime::block_on(mgr.shutdown_all());
            }
        });
}
