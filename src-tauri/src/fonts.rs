//! System font-family enumeration (`list_font_families` command): the settings
//! page's terminal-font picker offers the real installed families instead of a
//! hand-typed name that silently falls back to the default stack on a typo.
//!
//! Windows enumerates GDI families (`EnumFontFamiliesExW` — the same list every
//! classic app's font dialog shows); macOS goes through CoreText's
//! `CTFontManagerCopyAvailableFontFamilyNames`. Other platforms return an empty
//! list and the frontend falls back to the free-text input.

#[cfg(target_os = "windows")]
mod imp {
    use std::collections::BTreeSet;
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::Graphics::Gdi::{
        EnumFontFamiliesExW, GetDC, ReleaseDC, DEFAULT_CHARSET, LOGFONTW, TEXTMETRICW,
    };

    /// Collect one family name per callback; the shared set travels through
    /// the callback's lParam. Safety: the callback only touches the
    /// caller-owned set and copies the fixed-size LOGFONTW face-name buffer.
    unsafe extern "system" fn enum_proc(
        logfont: *const LOGFONTW,
        _metric: *const TEXTMETRICW,
        _fonttype: u32,
        lparam: LPARAM,
    ) -> i32 {
        let name = (*logfont).lfFaceName;
        let len = name.iter().position(|c| *c == 0).unwrap_or(name.len());
        let s = String::from_utf16_lossy(&name[..len]);
        // GDI reserves face names starting with '@' for vertical-layout variants
        // of the same family; the terminal never wants them listed separately.
        if !s.is_empty() && !s.starts_with('@') {
            // The set is not Sync, but the callback runs synchronously on the
            // same thread inside EnumFontFamiliesExW, so the alias is sound.
            (*(lparam.0 as *mut BTreeSet<String>)).insert(s);
        }
        1 // continue enumeration
    }

    pub fn families() -> Vec<String> {
        // Screen DC: EnumFontFamiliesExW only needs any valid DC handle.
        let dc = unsafe { GetDC(None) };
        if dc.is_invalid() {
            return Vec::new();
        }
        let mut set = BTreeSet::new();
        let logfont = LOGFONTW {
            lfCharSet: DEFAULT_CHARSET,
            lfFaceName: [0; 32],
            ..Default::default()
        };
        let lparam = LPARAM(&mut set as *mut BTreeSet<String> as isize);
        unsafe {
            // Returns 0 only when the callback stops early — ours never does;
            // a failing call simply leaves the set partially filled.
            let _ = EnumFontFamiliesExW(dc, &logfont, Some(enum_proc), lparam, 0);
            let _ = ReleaseDC(None, dc);
        }
        set.into_iter().collect()
    }
}
#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::imp;

    #[test]
    fn families_nonempty_sorted_deduped() {
        let list = imp::families();
        assert!(!list.is_empty(), "GDI enumeration returned no families");
        let mut sorted = list.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(list, sorted, "family list must be sorted & deduplicated");
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::collections::BTreeSet;

    // CoreText / CoreFoundation FFI: declaring the handful of C functions here
    // keeps the crate dependency-free (same thin-shell stance as the rest).
    #[link(name = "CoreText", kind = "dylib")]
    extern "C" {
        fn CTFontManagerCopyAvailableFontFamilyNames() -> isize; // CFArrayRef
    }
    #[link(name = "CoreFoundation", kind = "dylib")]
    extern "C" {
        fn CFArrayGetCount(array: isize) -> isize;
        fn CFArrayGetValueAtIndex(array: isize, idx: isize) -> isize; // CFStringRef
        fn CFStringGetCString(s: isize, buffer: *mut u8, buffer_size: isize, encoding: u32) -> bool;
        fn CFRelease(cf: isize);
    }

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    pub fn families() -> Vec<String> {
        unsafe {
            let array = CTFontManagerCopyAvailableFontFamilyNames();
            if array == 0 {
                return Vec::new();
            }
            let mut set = BTreeSet::new();
            let count = CFArrayGetCount(array);
            let mut buf = [0u8; 256];
            for i in 0..count {
                let s = CFArrayGetValueAtIndex(array, i);
                if s != 0
                    && CFStringGetCString(s, buf.as_mut_ptr(), buf.len() as isize, K_CF_STRING_ENCODING_UTF8)
                {
                    if let Ok(name) = std::ffi::CStr::from_ptr(buf.as_ptr() as *const std::ffi::c_char).to_str()
                    {
                        if !name.is_empty() {
                            set.insert(name.to_string());
                        }
                    }
                }
            }
            CFRelease(array);
            set.into_iter().collect()
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod imp {
    pub fn families() -> Vec<String> {
        Vec::new()
    }
}

/// Sorted, de-duplicated system font family names. Synchronous on purpose:
/// both platform APIs answer in single-digit milliseconds and the frontend
/// caches the result after the first call.
#[tauri::command]
pub fn list_font_families() -> Vec<String> {
    imp::families()
}
