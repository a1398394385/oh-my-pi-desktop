//! Tauri command 层：前端 ↔ 会话 actor 的桥。

use crate::omp::{EventSink, SessionManager};
use crate::sessions::{self, SessionMeta};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;

#[derive(Serialize)]
pub struct SpawnedSession {
    pub key: String,
    pub cwd: String,
}

#[tauri::command]
pub async fn omp_spawn(
    state: tauri::State<'_, SessionManager>,
    cwd: Option<String>,
    resume: Option<String>,
    on_event: Channel<Value>,
) -> Result<SpawnedSession, String> {
    let sink: EventSink = Arc::new(move |v| {
        let _ = on_event.send(v);
    });
    // 未指定工作目录时用进程当前目录（tauri dev 从项目根启动）
    let cwd_path = match cwd {
        Some(c) => PathBuf::from(c),
        None => std::env::current_dir().map_err(|e| format!("无法确定工作目录: {e}"))?,
    };
    let opts = crate::omp::SpawnOptions {
        cwd: cwd_path.clone(),
        resume_session: resume.map(PathBuf::from),
    };
    let handle = state.spawn(opts, sink).await?;
    Ok(SpawnedSession {
        key: handle.key.clone(),
        cwd: cwd_path.display().to_string(),
    })
}

/// 通用 RPC 命令：前端构造 `{type, ...}`，Rust 补 id 并等待同 id response。
#[tauri::command]
pub async fn omp_request(
    state: tauri::State<'_, SessionManager>,
    key: String,
    payload: Value,
) -> Result<Value, String> {
    let handle = state.get(&key).await.ok_or("会话不存在或已关闭")?;
    handle.request(payload, Duration::from_secs(30)).await
}

/// 审批等无应答帧的回执（fire-and-forget）。
#[tauri::command]
pub async fn omp_ui_response(
    state: tauri::State<'_, SessionManager>,
    key: String,
    frame: Value,
) -> Result<(), String> {
    let handle = state.get(&key).await.ok_or("会话不存在或已关闭")?;
    handle.send_frame(frame).await
}

/// 主动关闭一个会话（优雅关闭链：关 stdin → 等退出 → 超时 kill）。
#[tauri::command]
pub async fn omp_close(state: tauri::State<'_, SessionManager>, key: String) -> Result<(), String> {
    if let Some(handle) = state.remove(&key).await {
        handle.shutdown().await;
        if handle.wait_exit(Duration::from_secs(6)).await.is_none() {
            return Err("会话进程未在宽限期内退出".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn omp_stderr(
    state: tauri::State<'_, SessionManager>,
    key: String,
) -> Result<Vec<String>, String> {
    let handle = state.get(&key).await.ok_or("会话不存在或已关闭")?;
    Ok(handle.stderr_tail())
}

/// 左栏会话列表：只读扫描 profile 会话存储，按 cwd 过滤。
#[tauri::command]
pub fn omp_list_sessions(cwd: String) -> Result<Vec<SessionMeta>, String> {
    sessions::list_sessions(Path::new(&cwd))
}
