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
//! Windows posts the WinRT toast directly instead of through
//! tauri-plugin-notification: the plugin drops the toast handle right after
//! `show()`, so a click can never be observed, and notify-rust exposes neither
//! `activationType` nor `launch`. The toast root carries
//! `activationType="protocol" launch="omp-session:<encoded path>"`, and the same
//! URI is registered under HKCU\Software\Classes pointing at the running exe, so
//! a click reaches us as an argv argument — cold launch and hidden-window
//! relaunch alike — without a COM activator CLSID or an installer change.
//! Dev builds (target/debug|release) register nothing: the toast has no click
//! target and borrows PowerShell's AUMID, matching what the plugin did.
//! The alert sound is a plain system sound on both platforms and needs no
//! permission at all.

#[cfg(any(windows, test))]
use percent_encoding::{percent_decode_str, percent_encode, NON_ALPHANUMERIC};
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
    #[cfg(windows)]
    {
        win::send(&app, &title, &body, path.as_deref())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (app, title, body, path);
        Err("desktop notifications are not supported on this platform".into())
    }
}

#[cfg(any(target_os = "macos", windows))]
pub fn install(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    mac::install(app);
    #[cfg(windows)]
    {
        let _ = app;
        win::install();
    }
}

/// A click can arrive before the WebView has its listener (cold launch straight
/// from a toast): hold the last one natively and hand it over on request.
#[cfg(any(target_os = "macos", windows))]
mod open {
    use std::sync::Mutex;

    use tauri::{AppHandle, Emitter};

    #[derive(Default)]
    struct State {
        frontend_ready: bool,
        pending_path: Option<String>,
    }

    static STATE: Mutex<State> = Mutex::new(State {
        frontend_ready: false,
        pending_path: None,
    });

    pub fn frontend_ready() -> Option<String> {
        let mut state = STATE.lock().unwrap();
        state.frontend_ready = true;
        state.pending_path.take()
    }

    pub fn deliver(app: &AppHandle, path: String) {
        let mut state = STATE.lock().unwrap();
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
}

/// Marks the event listener as ready and returns a click received before that.
#[tauri::command]
pub fn notification_frontend_ready() -> Option<String> {
    #[cfg(any(target_os = "macos", windows))]
    {
        open::frontend_ready()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        None
    }
}

/// Consumes session paths carried by this process's command line (a protocol
/// launch from a toast click) and forwards them to the frontend.
#[cfg(windows)]
pub fn open_from_args(app: &AppHandle, args: impl IntoIterator<Item = String>) {
    for arg in args.into_iter().skip(1) {
        if let Some(path) = session_path(&arg) {
            crate::show_main_window(app);
            open::deliver(app, path);
        }
    }
}

/// Protocol scheme Windows hands back as argv after a toast click. The path is
/// percent-encoded into a single argument so the shell never re-splits it.
#[cfg(any(windows, test))]
const SESSION_SCHEME: &str = "omp-session";

#[cfg(any(windows, test))]
fn session_uri(path: &str) -> String {
    format!("{SESSION_SCHEME}:{}", percent_encode(path.as_bytes(), NON_ALPHANUMERIC))
}

/// Inverse of [`session_uri`]; `None` for any other command-line argument.
#[cfg(any(windows, test))]
fn session_path(arg: &str) -> Option<String> {
    let encoded = arg.strip_prefix(SESSION_SCHEME)?.strip_prefix(':')?;
    let path = percent_decode_str(encoded).decode_utf8().ok()?.into_owned();
    (!path.is_empty()).then_some(path)
}

/// Escapes the five XML metacharacters (title and body are free text).
#[cfg(any(windows, test))]
fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
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
    use std::sync::mpsc;
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
    use tauri::AppHandle;

    /// Upper bound for the synchronous waits on the notification center's reply
    /// blocks (they land on an internal queue and normally answer in <1 ms).
    const WAIT: Duration = Duration::from_secs(3);
    /// The authorization prompt waits for a click — give the user a minute before
    /// falling back to a plain status query.
    const REQUEST_WAIT: Duration = Duration::from_secs(60);

    const SESSION_REQUEST_PREFIX: &str = "omp-session:";

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
                    super::open::deliver(app, path.to_string());
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

/// WinRT toast with a protocol-activation click target. See the module docs for why
/// tauri-plugin-notification cannot do this.
#[cfg(windows)]
mod win {
    use std::path::Path;

    use tauri::AppHandle;
    use windows::core::{HSTRING, PCWSTR};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{RegCloseKey, RegCreateKeyW, RegSetValueExW, HKEY_CURRENT_USER, REG_SZ};

    /// Borrowed while running from a build tree: no toast click target exists there (the
    /// protocol handler is never registered for a throwaway exe) and Windows needs *some*
    /// AUMID to post at all — this is the shell's PowerShell identity, which is what the
    /// previous plugin path ended up using too.
    const POWERSHELL_APP_ID: &str =
        r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe";
    const PROTOCOL_KEY: &str = r"Software\Classes\omp-session";
    const COMMAND_KEY: &str = r"Software\Classes\omp-session\shell\open\command";

    /// Register the toast click target. Runs on every launch of an installed build, so a
    /// moved or replaced exe keeps working; HKCU needs no elevation.
    pub fn install() {
        let Ok(exe) = tauri::utils::platform::current_exe() else {
            eprintln!("[notify] protocol registration skipped: exe path unknown");
            return;
        };
        if is_build_tree(&exe) {
            return;
        }
        let command = format!("\"{}\" \"%1\"", exe.display());
        // The protocol key's default value is its display name; an empty `URL Protocol`
        // value is what makes the shell treat the key as a URL handler, not a file handler.
        let writes = [
            (PROTOCOL_KEY, None, "URL:omp session"),
            (PROTOCOL_KEY, Some("URL Protocol"), ""),
            (COMMAND_KEY, None, command.as_str()),
        ];
        for (key, name, value) in writes {
            if let Err(error) = write_string(key, name, value) {
                eprintln!("[notify] protocol registration failed ({key}): {error}");
            }
        }
    }

    pub fn send(app: &AppHandle, title: &str, body: &str, path: Option<&str>) -> Result<(), String> {
        let exe = tauri::utils::platform::current_exe().map_err(|e| format!("notify-failed: {e}"))?;
        let app_id = if is_build_tree(&exe) {
            POWERSHELL_APP_ID.to_string()
        } else {
            app.config().identifier.clone()
        };
        let launch = path.filter(|p| !p.is_empty()).map(super::session_uri);
        let xml = toast_xml(title, body, launch.as_deref());
        let document = XmlDocument::new().map_err(|e| format!("notify-failed: {e}"))?;
        document
            .LoadXml(&HSTRING::from(xml))
            .map_err(|e| format!("notify-failed: {e}"))?;
        let toast = ToastNotification::CreateToastNotification(&document)
            .map_err(|e| format!("notify-failed: {e}"))?;
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))
            .and_then(|notifier| notifier.Show(&toast))
            .map_err(|e| format!("notify-failed: {e}"))
    }

    /// `tauri dev` and unpackaged release builds run out of the build tree.
    fn is_build_tree(exe: &Path) -> bool {
        let dir = exe.parent().map(|d| d.display().to_string()).unwrap_or_default();
        dir.ends_with(r"target\debug") || dir.ends_with(r"target\release")
    }

    /// The app plays its own alert sound (`play_alert_sound`), so the toast stays silent —
    /// same split the previous notify-rust path had.
    fn toast_xml(title: &str, body: &str, launch: Option<&str>) -> String {
        let root = match launch {
            Some(uri) => format!(r#"<toast activationType="protocol" launch="{}">"#, super::xml_escape(uri)),
            None => "<toast>".to_string(),
        };
        format!(
            r#"{root}<visual><binding template="ToastGeneric"><text id="1">{}</text><text id="2">{}</text></binding></visual><audio silent="true" /></toast>"#,
            super::xml_escape(title),
            super::xml_escape(body)
        )
    }

    fn write_string(key: &str, name: Option<&str>, value: &str) -> Result<(), String> {
        let key_wide = wide(key);
        let mut hkey = windows::Win32::System::Registry::HKEY::default();
        let status = unsafe { RegCreateKeyW(HKEY_CURRENT_USER, PCWSTR(key_wide.as_ptr()), &mut hkey) };
        if status != ERROR_SUCCESS {
            return Err(format!("RegCreateKeyW: {}", status.0));
        }
        let name_wide = name.map(wide);
        let name = name_wide.as_ref().map_or(PCWSTR::null(), |w| PCWSTR(w.as_ptr()));
        let data = wide(value);
        // REG_SZ stores the UTF-16 bytes including the terminator.
        let bytes = unsafe { std::slice::from_raw_parts(data.as_ptr().cast::<u8>(), data.len() * 2) };
        let status = unsafe { RegSetValueExW(hkey, name, None, REG_SZ, Some(bytes)) };
        let _ = unsafe { RegCloseKey(hkey) };
        (status == ERROR_SUCCESS).then_some(()).ok_or_else(|| format!("RegSetValueExW: {}", status.0))
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
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

#[cfg(test)]
mod uri_tests {
    /// The toast click path round-trips as one argv argument: the scheme separator,
    /// spaces, `&`, `|` (the single-instance argv separator) and non-ASCII must all
    /// survive the encode/decode pair.
    #[test]
    fn session_uri_round_trips_a_windows_path() {
        let path = r"C:\Users\张三\会话 1 & more|notes.jsonl";
        let uri = super::session_uri(path);
        assert_eq!(super::session_path(&uri).as_deref(), Some(path));
        assert!(!uri.contains(' '), "unencoded space in {uri}");
        assert!(!uri.contains('|'), "unencoded argv separator in {uri}");
        assert!(!uri.contains('&'), "unescaped XML ampersand in {uri}");
    }

    #[test]
    fn unrelated_arguments_are_not_session_paths() {
        assert_eq!(super::session_path("--flag"), None);
        assert_eq!(super::session_path("omp-session:"), None);
        assert_eq!(super::session_path("omp-session-not-a-uri"), None);
    }

    #[test]
    fn xml_escape_covers_every_metacharacter() {
        assert_eq!(super::xml_escape(r#"<a & "b" 'c'>"#), "&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;");
    }
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
