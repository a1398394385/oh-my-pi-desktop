//! Desktop alerts for background session events (turn finished / waiting for
//! approval): a system notification, click-to-open-session, and the platform alert sound.
//!
//! macOS notifications go through UNUserNotificationCenter instead of
//! tauri-plugin-notification. The plugin's macOS backend is the legacy
//! NSUserNotification API (mac-notification-sys), which macOS 15+ answers with
//! "You can't mix modern clients with legacy clients" for every app the system
//! knows as a modern client — and in `tauri dev` the plugin re-brands the
//! notification as com.apple.Terminal, so it lands in the wrong app's settings.
//! Three macOS constraints the code below has to respect:
//!   * a bare binary (`tauri dev` runs target/debug/omp-desktop, no .app) has no
//!     bundle proxy: calling currentNotificationCenter there aborts the process,
//!     so the bundle id is checked first and the call is skipped when absent;
//!   * the bundle must be known to LaunchServices (an installed .app): the same
//!     bundle run out of a temp directory is answered with "Notifications are
//!     not allowed for this application";
//!   * the first notification needs the user's approval. While authorization is
//!     undecided this command only triggers the system prompt and reports that;
//!     a denied state is reported with its reason, so the UI can say why nothing
//!     appears instead of failing silently.
//! Windows keeps the plugin (WinRT toast with the app identifier).
//! The alert sound is a plain system sound on both platforms and needs no
//! permission at all.

use tauri::AppHandle;

/// Frontend call: post a desktop notification.
/// Args (frontend camelCase auto-mapped): title / body / path.
#[tauri::command]
pub async fn send_desktop_notification(
    app: AppHandle,
    title: String,
    body: String,
    path: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        mac::send(&title, &body, path.as_deref())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        use tauri_plugin_notification::NotificationExt;
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|e| format!("notify-failed: {e}"))
    }
}

#[cfg(target_os = "macos")]
pub fn install(app: &AppHandle) {
    mac::install(app);
}

/// Marks the event listener as ready and returns a click received before that.
#[tauri::command]
pub fn notification_frontend_ready() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        mac::frontend_ready()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Frontend call: play the platform alert sound (the user's system sound scheme applies).
#[tauri::command]
pub fn play_alert_sound() {
    sound::play();
}

/// Frontend call: current notification authorization, for the settings page row.
/// "authorized" | "provisional" | "denied" | "notDetermined" | "unavailable" (no app bundle:
/// the dev binary cannot use the notification center) | "unsupported" (platform without an
/// authorization model, e.g. Windows).
#[tauri::command]
pub async fn notification_permission_status() -> String {
    #[cfg(target_os = "macos")]
    {
        mac::permission_status()
    }
    #[cfg(not(target_os = "macos"))]
    {
        "unsupported".to_string()
    }
}

/// Frontend call: ask the system for notification authorization (macOS shows its prompt) and
/// report the resulting state. Waits for the user's answer, hence async.
#[tauri::command]
pub async fn request_notification_permission() -> String {
    #[cfg(target_os = "macos")]
    {
        mac::request_permission()
    }
    #[cfg(not(target_os = "macos"))]
    {
        "unsupported".to_string()
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::sync::{mpsc, Mutex};
    use std::time::Duration;

    use block2::{DynBlock, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AnyThread, DefinedClass};
    use objc2_foundation::{NSBundle, NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent,
        UNNotificationRequest, UNNotificationResponse, UNNotificationSettings,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use tauri::{AppHandle, Emitter};

    /// Upper bound for the synchronous waits on the notification center's reply
    /// blocks (they land on an internal queue and normally answer in <1 ms).
    const WAIT: Duration = Duration::from_secs(3);
    /// The authorization prompt waits for a click — give the user a minute before
    /// falling back to a plain status query.
    const REQUEST_WAIT: Duration = Duration::from_secs(60);

    const SESSION_REQUEST_PREFIX: &str = "omp-session:";

    #[derive(Default)]
    struct OpenState {
        frontend_ready: bool,
        pending_path: Option<String>,
    }

    static OPEN_STATE: Mutex<OpenState> = Mutex::new(OpenState {
        frontend_ready: false,
        pending_path: None,
    });

    struct NotificationDelegateIvars {
        app: AppHandle,
    }

    define_class!(
        // SAFETY: the delegate has plain Rust ivars and no Drop implementation.
        #[unsafe(super(NSObject))]
        #[ivars = NotificationDelegateIvars]
        struct NotificationDelegate;

        impl NotificationDelegate {
            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion_handler: &DynBlock<dyn Fn()>,
            ) {
                let app = &self.ivars().app;
                crate::show_main_window(app);
                let identifier = response.notification().request().identifier();
                if let Some(path) = session_path(&identifier.to_string()) {
                    deliver_open(app, path.to_string());
                }
                completion_handler.call(());
            }
        }

        unsafe impl NSObjectProtocol for NotificationDelegate {}
        // The optional callback is registered above as a plain class method.
        unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {}
    );

    impl NotificationDelegate {
        fn new(app: AppHandle) -> Retained<Self> {
            let this = Self::alloc().set_ivars(NotificationDelegateIvars { app });
            unsafe { msg_send![super(this), init] }
        }
    }

    pub fn install(app: &AppHandle) {
        // A bare dev binary has no bundle proxy; querying the center would abort it.
        if NSBundle::mainBundle().bundleIdentifier().is_none() {
            return;
        }
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let delegate = NotificationDelegate::new(app.clone());
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // The center's delegate property is weak; this singleton lives for the process.
        std::mem::forget(delegate);
    }

    pub fn frontend_ready() -> Option<String> {
        let mut state = OPEN_STATE.lock().unwrap();
        state.frontend_ready = true;
        state.pending_path.take()
    }

    fn deliver_open(app: &AppHandle, path: String) {
        let mut state = OPEN_STATE.lock().unwrap();
        if !state.frontend_ready {
            // Only the latest pre-listener click is actionable.
            state.pending_path = Some(path);
            return;
        }
        drop(state);
        if let Err(error) = app.emit("notification-open", serde_json::json!({ "path": path })) {
            eprintln!("[notify] open event failed: {error}");
        }
    }

    pub(crate) fn session_path(identifier: &str) -> Option<&str> {
        let (_, path) = identifier
            .strip_prefix(SESSION_REQUEST_PREFIX)?
            .split_once(':')?;
        (!path.is_empty()).then_some(path)
    }

    /// Settings-page row state (see the command docs for the vocabulary).
    pub fn permission_status() -> String {
        if NSBundle::mainBundle().bundleIdentifier().is_none() {
            return "unavailable".into();
        }
        match status(&UNUserNotificationCenter::currentNotificationCenter()) {
            Ok(s) => status_name(s).into(),
            Err(_) => "unknown".into(),
        }
    }

    /// Ask for authorization and report the state the user settled on.
    pub fn request_permission() -> String {
        if NSBundle::mainBundle().bundleIdentifier().is_none() {
            return "unavailable".into();
        }
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let (tx, rx) = mpsc::channel();
        let handler = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            let detail = unsafe { error.as_ref() }.map(|e| e.localizedDescription().to_string());
            eprintln!("[notify] authorization granted={} detail={detail:?}", granted.as_bool());
            let _ = tx.send(());
        });
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &handler,
        );
        let _ = rx.recv_timeout(REQUEST_WAIT);
        match status(&center) {
            Ok(s) => status_name(s).into(),
            Err(_) => "unknown".into(),
        }
    }

    fn status_name(status: UNAuthorizationStatus) -> &'static str {
        if status == UNAuthorizationStatus::Authorized {
            "authorized"
        } else if status == UNAuthorizationStatus::Provisional {
            "provisional"
        } else if status == UNAuthorizationStatus::Denied {
            "denied"
        } else {
            "notDetermined"
        }
    }

    pub fn send(title: &str, body: &str, path: Option<&str>) -> Result<(), String> {
        // No bundle id (dev binary): the notification center would abort the process.
        if NSBundle::mainBundle().bundleIdentifier().is_none() {
            return Err("no app bundle: macOS notifications need an installed .app".into());
        }
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let status = status(&center)?;
        if status == UNAuthorizationStatus::NotDetermined {
            request_authorization(&center);
            return Err("notification permission requested: approve it in System Settings ▸ Notifications".into());
        }
        if status != UNAuthorizationStatus::Authorized && status != UNAuthorizationStatus::Provisional {
            return Err("macOS notifications are turned off for this app (System Settings ▸ Notifications)".into());
        }
        post(&center, title, body, path)
    }

    fn status(center: &UNUserNotificationCenter) -> Result<UNAuthorizationStatus, String> {
        let (tx, rx) = mpsc::channel();
        let handler = RcBlock::new(move |settings: std::ptr::NonNull<UNNotificationSettings>| {
            let _ = tx.send(unsafe { settings.as_ref() }.authorizationStatus());
        });
        center.getNotificationSettingsWithCompletionHandler(&handler);
        rx.recv_timeout(WAIT).map_err(|_| "notification settings query timed out".to_string())
    }

    /// Ask once for authorization. The prompt waits for a user click, so this never blocks.
    fn request_authorization(center: &UNUserNotificationCenter) {
        let handler = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            let detail = unsafe { error.as_ref() }.map(|e| e.localizedDescription().to_string());
            eprintln!("[notify] authorization granted={} detail={detail:?}", granted.as_bool());
        });
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &handler,
        );
    }

    fn post(
        center: &UNUserNotificationCenter,
        title: &str,
        body: &str,
        path: Option<&str>,
    ) -> Result<(), String> {
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        // The request id survives cold launch and avoids a separate userInfo dictionary.
        let id = match path {
            Some(path) if !path.is_empty() => format!("{SESSION_REQUEST_PREFIX}{stamp}:{path}"),
            _ => format!("omp-{stamp}"),
        };
        let id = NSString::from_str(&id);
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&id, &content, None);
        let (tx, rx) = mpsc::channel();
        let handler = RcBlock::new(move |error: *mut NSError| {
            let _ = tx.send(unsafe { error.as_ref() }.map(|e| e.localizedDescription().to_string()));
        });
        center.addNotificationRequest_withCompletionHandler(&request, Some(&handler));
        match rx.recv_timeout(WAIT) {
            Ok(None) => Ok(()),
            Ok(Some(detail)) => Err(format!("notification rejected: {detail}")),
            Err(_) => Err("notification request timed out".into()),
        }
    }
}

#[cfg(target_os = "macos")]
mod sound {
    use std::cell::OnceCell;

    use objc2::rc::Retained;
    use objc2_app_kit::NSSound;
    use objc2_foundation::NSString;

    /// System alert sound as a file. AudioServicesPlayAlertSound(kSystemSoundID_UserPreferredAlert)
    /// was the previous path, but on macOS 27 every system sound ID fails in CoreAudio with
    /// `Failure to setup sound, err = -50`, so the alert is played through NSSound instead
    /// (AudioQueue-backed file playback, honours the output volume).
    const ALERT_SOUND: &str = "Glass";

    thread_local! {
        /// Loaded once per calling thread and kept alive: NSSound stops when its object is
        /// released mid-playback, and Retained<NSSound> is neither Send nor Sync.
        static ALERT: OnceCell<Option<Retained<NSSound>>> = const { OnceCell::new() };
    }

    pub fn play() {
        ALERT.with(|cell| {
            if let Some(s) = cell.get_or_init(|| NSSound::soundNamed(&NSString::from_str(ALERT_SOUND))) {
                // Back-to-back alerts: play() on a playing sound is a no-op, restart instead.
                s.stop();
                s.play();
            }
        });
    }
}

#[cfg(windows)]
mod sound {
    use windows::Win32::System::Diagnostics::Debug::MessageBeep;
    use windows::Win32::UI::WindowsAndMessaging::MB_ICONASTERISK;

    /// System asterisk sound (honours the Windows sound scheme).
    pub fn play() {
        let _ = unsafe { MessageBeep(MB_ICONASTERISK) };
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod sound {
    pub fn play() {}
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    /// A bare binary (what `tauri dev` and `cargo test` run) has no bundle proxy: the
    /// notification center would abort the process, so the guard must answer with an
    /// error instead of calling into it.
    #[test]
    fn send_without_bundle_errors_instead_of_aborting() {
        let err = super::mac::send("title", "body", None).unwrap_err();
        assert!(err.contains("no app bundle"), "unexpected error: {err}");
    }

    #[test]
    fn session_request_identifier_round_trips_paths_with_colons() {
        let path = "/tmp/project:with-colon/session.jsonl";
        let identifier = format!("omp-session:123:{path}");
        assert_eq!(super::mac::session_path(&identifier), Some(path));
        assert_eq!(super::mac::session_path("omp-123"), None);
    }

    /// Same guard for the settings-page row: without a bundle the status is
    /// reported as unavailable, never queried through the notification center.
    #[test]
    fn permission_status_without_bundle_is_unavailable() {
        assert_eq!(super::mac::permission_status(), "unavailable");
    }
}
