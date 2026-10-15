//! App auto-update: check the release manifest, download+install the bundle, relaunch.
//!
//! Implemented against `tauri-plugin-updater` directly rather than through its JS
//! bindings: this project's frontend does not bundle `@tauri-apps/*` (it uses the
//! `withGlobalTauri` globals), and the plugin's `download` command takes an IPC
//! `Channel` for progress that the frontend would otherwise have to construct by
//! hand. Three plain commands plus two progress events are less surface than
//! reimplementing that Channel plumbing in TS.
//!
//! Download and install are ONE command on purpose: the plugin returns an `Update`
//! handle from `check()` that `install()` consumes, so splitting them would mean
//! parking that handle in managed state across two round trips while still holding
//! the whole bundle in memory.

use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// Progress event name (payload: [`UpdateProgress`]).
const PROGRESS_EVENT: &str = "update-progress";
/// Emitted after the bundle is installed, before the shell restarts.
const INSTALLED_EVENT: &str = "update-installed";

/// What the settings page shows before the user commits to a large download.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// Version on offer; the running version when `available` is false.
    pub version: String,
    /// Version currently running.
    pub current_version: String,
    /// Release notes; empty when the manifest carries none.
    pub body: String,
    /// RFC 3339 publish date; absent when the manifest omits it.
    pub date: Option<String>,
    /// False when the running build is already current.
    pub available: bool,
}

/// Download progress. `downloaded` is a running byte total, not a chunk delta —
/// the frontend renders a percentage and would otherwise have to re-add deltas.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub downloaded: u64,
    /// Total bundle size; absent when the server sends no Content-Length.
    pub total: Option<u64>,
    /// True once the bytes are on disk and the install is starting.
    pub finished: bool,
}

/// Frontend call: ask the release endpoint whether a newer build exists.
/// Returns `available: false` rather than an error when the app is current — "no
/// update" is a normal answer and maps to one toast; errors are reserved for
/// "could not reach or parse the manifest".
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateInfo, String> {
    let updater = app.updater().map_err(|e| format!("update-init-failed: {e}"))?;
    let found = updater.check().await.map_err(|e| format!("update-check-failed: {e}"))?;
    let current = app.package_info().version.to_string();
    let Some(update) = found else {
        return Ok(UpdateInfo {
            version: current.clone(),
            current_version: current,
            body: String::new(),
            date: None,
            available: false,
        });
    };
    let date = update.date.map(|d| d.to_string());
    Ok(UpdateInfo {
        version: update.version.to_string(),
        current_version: update.current_version,
        body: update.body.unwrap_or_default(),
        date,
        available: true,
    })
}

/// Frontend call: download the pending update and install it, emitting
/// `update-progress` throughout. Does NOT restart — the frontend asks first, so a
/// user with running agents can defer until they choose to restart.
///
/// Returns only on failure; on success the caller gets the `update-installed` event
/// and then calls `update_relaunch`. On Windows the installer cannot replace a
/// running executable, so the plugin quits the app during install — hence `finished`
/// carries the last progress event the frontend will ever see on that platform.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| format!("update-init-failed: {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("update-check-failed: {e}"))?
        .ok_or_else(|| "update-none-pending".to_string())?;

    // Running byte total lives here, not in the frontend: the plugin reports chunk
    // deltas, and a per-chunk re-add in TS would be duplicated state.
    let downloaded = AtomicU64::new(0);
    let chunk_app = app.clone();
    let finish_app = app.clone();
    update
        .download_and_install(
            move |chunk_length, content_length| {
                let seen = downloaded.fetch_add(chunk_length as u64, Ordering::Relaxed) + chunk_length as u64;
                let _ = chunk_app.emit(
                    PROGRESS_EVENT,
                    UpdateProgress {
                        downloaded: seen,
                        total: content_length,
                        finished: false,
                    },
                );
            },
            move || {
                let _ = finish_app.emit(
                    PROGRESS_EVENT,
                    UpdateProgress {
                        downloaded: 0,
                        total: None,
                        finished: true,
                    },
                );
            },
        )
        .await
        .map_err(|e| format!("update-install-failed: {e}"))?;
    let _ = app.emit(INSTALLED_EVENT, ());
    Ok(())
}

/// Frontend call: re-exec the shell so the freshly installed bundle takes effect.
/// Core Tauri's restart rather than tauri-plugin-process: the plugin only wraps this
/// same call, and it would be a second capability for one function. Never returns —
/// the running image is replaced.
#[tauri::command]
pub fn update_relaunch(app: AppHandle) {
    app.restart();
}