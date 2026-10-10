//! System permission (macOS TCC) status preflight + opening the matching System
//! Settings pane, backing the "System permissions" card on the general settings
//! page (computer-use control / screen capture / file access).
//!
//! Every status check is a prompt-free preflight — nothing here can pop a TCC
//! dialog from the settings page:
//! - accessibility: `AXIsProcessTrusted` (ApplicationServices) — the AX/CGEvent
//!   APIs computer use needs to control mouse & keyboard.
//! - screen capture: `CGPreflightScreenCaptureAccess` (CoreGraphics, 10.15+) —
//!   computer-use screen capture.
//! - full disk access: reading `/Library/Application Support/com.apple.TCC`
//!   succeeds only with FDA granted (the standard community probe; FDA has no
//!   prompt mechanism, so the denied read is silent).
//! Other platforms report an all-false status and refuse to open (the frontend
//! only mounts the card on macOS anyway).

use serde::Serialize;

/// TCC snapshot for one render of the permissions card. Field names are the
/// frontend's row keys and the open-command's panel ids.
#[derive(Serialize)]
pub struct PermissionStatus {
    pub accessibility: bool,
    pub screen_capture: bool,
    pub full_disk_access: bool,
}

#[cfg(target_os = "macos")]
mod imp {
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> u8; // Boolean
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
    }

    pub fn accessibility() -> bool {
        unsafe { AXIsProcessTrusted() != 0 }
    }

    pub fn screen_capture() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() }
    }

    pub fn full_disk_access() -> bool {
        std::fs::read_dir("/Library/Application Support/com.apple.TCC").is_ok()
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn accessibility() -> bool {
        false
    }
    pub fn screen_capture() -> bool {
        false
    }
    pub fn full_disk_access() -> bool {
        false
    }
}

/// Frontend call: current TCC status for every card row. The frontend
/// re-queries on window focus so a permission toggled in System Settings is
/// reflected as soon as the app is fronted again.
#[tauri::command]
pub fn system_permission_status() -> PermissionStatus {
    PermissionStatus {
        accessibility: imp::accessibility(),
        screen_capture: imp::screen_capture(),
        full_disk_access: imp::full_disk_access(),
    }
}

/// Security-pane anchor per card row (whitelist: unknown panel ids fail fast
/// instead of being interpolated into the settings URL).
#[cfg(target_os = "macos")]
fn pane_anchor(panel: &str) -> Option<&'static str> {
    match panel {
        "accessibility" => Some("Privacy_Accessibility"),
        "screen_capture" => Some("Privacy_ScreenCapture"),
        "full_disk_access" => Some("Privacy_AllFiles"),
        _ => None,
    }
}

/// Frontend call: open the System Settings pane matching one card row. The
/// legacy `x-apple.systempreferences:` URL still routes on Ventura+ (it opens
/// the right pane, though it cannot deep-link to this app's row inside it).
#[tauri::command]
pub fn open_permission_setting(panel: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let anchor =
            pane_anchor(&panel).ok_or_else(|| format!("unknown permission panel: {panel}"))?;
        std::process::Command::new("/usr/bin/open")
            .arg(format!(
                "x-apple.systempreferences:com.apple.preference.security?{anchor}"
            ))
            .status()
            .map(|_| ())
            .map_err(|e| format!("open System Settings failed: {e}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = panel;
        Err("permission settings are macOS-only".into())
    }
}
