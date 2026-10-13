//! macOS capture: ScreenCaptureKit stream over the system's default output.
//! SCK has no per-device audio selection — a display's audio device IS the
//! default output — so `device_id` is ignored and `audio_devices` reports a
//! single "system default" entry. Requires the Screen Recording TCC
//! permission; `CGRequestScreenCaptureAccess` prompts on first use.
//!
//! Effectively pictureless: 2×2 viewport, only an audio output registered.
//! Audio arrives as deinterleaved f32 (one AudioBuffer per channel) on the
//! sample-handler queue; the callback mixes to mono into a bounded ring and the
//! emit thread below folds the newest 2048 samples through the shared
//! [`Analyzer`] every ~33 ms.

use std::collections::VecDeque;
use std::ptr;
use std::slice;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread, DefinedClass};
use std::ptr::NonNull;
use objc2_core_audio::{AudioObjectGetPropertyData, AudioObjectPropertyAddress};
use objc2_core_foundation::CFString;
use objc2_core_media::CMSampleBuffer;
use objc2_foundation::{NSArray, NSError};
use objc2_screen_capture_kit::{
    SCContentFilter, SCDisplay, SCShareableContent, SCStream, SCStreamConfiguration,
    SCStreamDelegate, SCStreamOutput, SCStreamOutputType, SCWindow,
};
use parking_lot::{Condvar, Mutex};
use tauri::{AppHandle, Emitter};

use super::{Analyzer, AudioDevice, EVENT, FFT_SIZE, FRAME_MS, SpectrumFrame, STATE_EVENT};

extern "C" {
    fn CGMainDisplayID() -> u32;
    fn CGRequestScreenCaptureAccess() -> bool;
}

const fn fourcc(s: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*s)
}

const SYSTEM_OBJECT: u32 = 1; // kAudioObjectSystemObject
const SCOPE_GLOBAL: u32 = fourcc(b"glob"); // kAudioObjectPropertyScopeGlobal
const ELEMENT_MASTER: u32 = 0; // kAudioObjectPropertyElementMaster

/// Ring cap in samples (~170 ms at 48 kHz). The emit thread consumes every
/// FRAME_MS, so this is only a safety valve against a wedged consumer.
const RING_CAP: usize = 8192;

pub fn list_devices() -> Result<Vec<AudioDevice>, String> {
    Ok(vec![AudioDevice { id: String::new(), name: default_output_name() }])
}

/// Human name of the current default output device (CoreAudio property query,
/// no TCC permission involved). Falls back to a generic label on any failure.
fn default_output_name() -> String {
    unsafe {
        let mut dev = 0u32;
        let addr = AudioObjectPropertyAddress {
            mSelector: fourcc(b"dOut"), // kAudioHardwarePropertyDefaultOutputDevice
            mScope: SCOPE_GLOBAL,
            mElement: ELEMENT_MASTER,
        };
        let mut size = 4u32;
        if AudioObjectGetPropertyData(
            SYSTEM_OBJECT,
            NonNull::from(&addr),
            0,
            ptr::null(),
            NonNull::from(&mut size),
            NonNull::from(&mut dev).cast(),
        ) != 0
        {
            return "System default output".into();
        }
        let name_addr = AudioObjectPropertyAddress {
            mSelector: fourcc(b"lnam"), // kAudioObjectPropertyName (localized)
            mScope: SCOPE_GLOBAL,
            mElement: ELEMENT_MASTER,
        };
        let mut name: *mut CFString = ptr::null_mut();
        let mut name_size = size_of::<*mut CFString>() as u32;
        if AudioObjectGetPropertyData(
            dev,
            NonNull::from(&name_addr),
            0,
            ptr::null(),
            NonNull::from(&mut name_size),
            NonNull::from(&mut name).cast(),
        ) != 0
            || name.is_null()
        {
            return "System default output".into();
        }
        (*name).to_string()
    }
}

fn ns_error_string(err: *mut NSError) -> String {
    if err.is_null() {
        return "unknown error".into();
    }
    unsafe { (*err).localizedDescription().to_string() }
}

/// Completion-only SCK API → synchronous call with a 5 s bound. The capture
/// thread can afford to block.
fn wait_slot<T>(slot: &Arc<(Mutex<Option<T>>, Condvar)>) -> Option<T> {
    let (m, cv) = (&slot.0, &slot.1);
    let mut guard = m.lock();
    loop {
        if guard.is_some() {
            return guard.take();
        }
        let t = cv.wait_for(&mut guard, Duration::from_secs(5));
        if t.timed_out() {
            return guard.take();
        }
    }
}

fn shareable_content() -> Result<Retained<SCShareableContent>, String> {
    let slot = Arc::new((
        Mutex::new(None::<Result<Retained<SCShareableContent>, String>>),
        Condvar::new(),
    ));
    let s2 = slot.clone();
    let handler = RcBlock::new(move |content: *mut SCShareableContent, err: *mut NSError| {
        let res = if content.is_null() {
            Err(ns_error_string(err))
        } else {
            // SAFETY: non-null pointer handed over by the completion handler.
            match unsafe { Retained::retain(content) } {
                Some(r) => Ok(r),
                None => Err("failed to retain shareable content".into()),
            }
        };
        *s2.0.lock() = Some(res);
        s2.1.notify_all();
    });
    unsafe { SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(false, false, &handler) };
    wait_slot(&slot).unwrap_or_else(|| Err("SCShareableContent timed out".into()))
}

/// The audio tap: protocol object receiving sample buffers on the handler
/// queue, mixing them to mono into the shared ring.
struct AudioTapIvars {
    ring: Arc<Mutex<VecDeque<f32>>>,
}

define_class!(
    /// SAFETY: NSObject subclassing requirements are trivial; AudioTap does not
    /// implement Drop (the ivars are plain Rust data).
    #[unsafe(super(NSObject))]
    #[ivars = AudioTapIvars]
    struct AudioTap;

    impl AudioTap {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        unsafe fn did_output(
            &self,
            _stream: &SCStream,
            buf: &CMSampleBuffer,
            r#type: SCStreamOutputType,
        ) {
            if r#type != SCStreamOutputType::Audio {
                return;
            }
            let frames = buf.num_samples() as usize;
            if frames == 0 {
                return;
            }
            // Non-interleaved f32 with all channels contiguous in one data
            // buffer (verified via the format description: 'lpcm' 0x29, block
            // length = frames × channels × 4). The AudioBufferList extraction
            // (CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer) rejects
            // these buffers with -12731 on macOS 15+, so read the data buffer
            // directly and split it into equal per-channel chunks.
            let Some(bb) = buf.data_buffer() else { return };
            let mut ptr: *mut std::ffi::c_char = ptr::null_mut();
            let mut total = 0usize;
            if unsafe { bb.data_pointer(0, ptr::null_mut(), &mut total, &mut ptr) } != 0
                || ptr.is_null()
            {
                return;
            }
            let bytes_per_ch = frames * 4;
            if bytes_per_ch == 0 || !total.is_multiple_of(bytes_per_ch) {
                return;
            }
            let n_ch = (total / bytes_per_ch).clamp(1, 8);
            // SAFETY: `ptr` addresses `total` contiguous bytes of f32 sample
            // data per the checks above.
            let base = unsafe { slice::from_raw_parts(ptr.cast::<f32>(), total / 4) };
            let mut out = VecDeque::with_capacity(frames);
            for i in 0..frames {
                let mut sum = 0f32;
                for ch in 0..n_ch {
                    sum += base[ch * frames + i];
                }
                out.push_back(sum / n_ch as f32);
            }
            let mut ring = self.ivars().ring.lock();
            ring.extend(out);
            let excess = ring.len().saturating_sub(RING_CAP);
            if excess > 0 {
                ring.drain(..excess);
            }
        }
    }

    // Stream death (device unplugged, TCC revoked) arrives here; the capture
    // thread only notices indirectly (emit failing), so log the cause. Bare
    // method rather than the optional-protocol impl — objc2 cannot verify
    // optional overrides — the runtime dispatches by selector all the same.
    impl AudioTap {
        #[unsafe(method(stream:didStopStreamWithError:))]
        #[allow(non_snake_case)]
        unsafe fn stream_didStopWithError(&self, _stream: &SCStream, error: &NSError) {
            eprintln!("[audio] mac stream stopped: {}", error.localizedDescription());
        }
    }

    unsafe impl NSObjectProtocol for AudioTap {}

    unsafe impl SCStreamOutput for AudioTap {}

    // Empty trait impl: the delegate method above is registered as a plain
    // class method (objc2 cannot verify optional-protocol overrides), this
    // only satisfies ProtocolObject<dyn SCStreamDelegate>'s trait bound.
    unsafe impl SCStreamDelegate for AudioTap {}
);

fn start_or_stop_capture(stream: &SCStream, start: bool) -> Result<(), String> {
    let slot = Arc::new((Mutex::new(None::<Result<(), String>>), Condvar::new()));
    let s2 = slot.clone();
    let handler = RcBlock::new(move |err: *mut NSError| {
        let res = if err.is_null() {
            Ok(())
        } else {
            Err(ns_error_string(err))
        };
        *s2.0.lock() = Some(res);
        s2.1.notify_all();
    });
    if start {
        unsafe { stream.startCaptureWithCompletionHandler(Some(&handler)) };
    } else {
        unsafe { stream.stopCaptureWithCompletionHandler(Some(&handler)) };
    }
    wait_slot(&slot).unwrap_or_else(|| Err("capture start/stop timed out".into()))
}

/// Screen Recording permission gate. `CGRequestScreenCaptureAccess` prompts on
/// first use; without the grant SCK silently delivers nothing, so gate up front
/// with a clear error.
fn request_permission() -> Result<(), String> {
    if !unsafe { CGRequestScreenCaptureAccess() } {
        Err(
            "Screen Recording permission not granted (System Settings > Privacy & Security > Screen Recording)"
                .into(),
        )
    } else {
        Ok(())
    }
}

/// Build the audio-only SCK stream feeding `ring`; permission must already be
/// granted. Returns the tap alongside the stream: the stream holds it only
/// weakly (SCStream delegate/output are not retained — verified on macOS 27,
/// where dropping the tap mid-stream kills every callback), so the caller must
/// keep it alive for the capture's lifetime.
fn open_stream(ring: Arc<Mutex<VecDeque<f32>>>) -> Result<(Retained<SCStream>, Retained<AudioTap>), String> {
    unsafe {
        let content = shareable_content()?;
        let displays = content.displays();
        let main = CGMainDisplayID();
        let mut display: Option<Retained<SCDisplay>> = None;
        for i in 0..displays.len() {
            let d = displays.objectAtIndex(i);
            if d.displayID() == main {
                display = Some(d);
                break;
            }
        }
        let display = display.unwrap_or_else(|| displays.objectAtIndex(0));

        let empty_windows: Retained<NSArray<SCWindow>> = NSArray::new();
        let filter = SCContentFilter::initWithDisplay_excludingWindows(
            SCContentFilter::alloc(),
            &display,
            &empty_windows,
        );
        let config = SCStreamConfiguration::new();
        config.setCapturesAudio(true);
        // WASAPI loopback carries this process's own sound too (TTS, bell); keep
        // parity instead of diverging on macOS.
        config.setExcludesCurrentProcessAudio(false);
        config.setSampleRate(48_000);
        config.setChannelCount(2);
        config.setQueueDepth(8);
        config.setWidth(2);
        config.setHeight(2);

        let tap = AudioTap::new(ring);
        let stream = SCStream::initWithFilter_configuration_delegate(
            SCStream::alloc(),
            &filter,
            &config,
            Some(ProtocolObject::from_ref(&*tap)),
        );
        // A serial queue is not required, but keeps callbacks ordered.
        let queue = DispatchQueue::new("dev.omp.rail-audio", None);
        stream
            .addStreamOutput_type_sampleHandlerQueue_error(
                ProtocolObject::from_ref(&*tap),
                SCStreamOutputType::Audio,
                Some(&queue),
            )
            .map_err(|e| e.localizedDescription().to_string())?;
        Ok((stream, tap))
    }
}

pub fn run_capture(app: &AppHandle, stop: &AtomicBool, _device_id: &str) -> Result<(), String> {
    request_permission()?;
    let ring = Arc::new(Mutex::new(VecDeque::new()));
    let (stream, _tap) = open_stream(ring.clone())?;
    start_or_stop_capture(&stream, true)?;

    let device_name = default_output_name();
    let _ = app.emit(STATE_EVENT, serde_json::json!({ "active": true, "device": device_name }));

    let mut analyzer = Analyzer::new(48_000.0);
    let mut mono = vec![0f32; FFT_SIZE];
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(FRAME_MS));
        let samples: Vec<f32> = { let mut g = ring.lock(); g.drain(..).collect() };
        if samples.is_empty() {
            continue;
        }
        // Newest FFT_SIZE samples win; older samples beyond the window are
        // dropped, a partially filled window is zero-padded at the front.
        let take = samples.len().min(FFT_SIZE);
        mono.fill(0.0);
        mono[FFT_SIZE - take..].copy_from_slice(&samples[samples.len() - take..]);
        let peak = analyzer.analyze(&mono);
        let frame = SpectrumFrame { bands: analyzer.envelope.clone(), peak };
        if app.emit(EVENT, &frame).is_err() {
            // Webview gone (app shutting down): stop capturing.
            break;
        }
    }
    let _ = start_or_stop_capture(&stream, false);
    drop(stream);
    Ok(())
}

impl AudioTap {
    fn new(ring: Arc<Mutex<VecDeque<f32>>>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(AudioTapIvars { ring });
        unsafe { msg_send![super(this), init] }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
    }

    /// Smoke: with Screen Recording already granted, the stream must deliver
    /// audio sample buffers (silence still ships zero-valued buffers, so the
    /// ring fills regardless of what is playing). Skips — never prompts — when
    /// the permission is missing for the test binary.
    #[test]
    fn stream_delivers_sample_buffers() {
        // CoreAudio enumeration needs no permission — always verified.
        let devices = list_devices().expect("list devices");
        assert_eq!(devices.len(), 1, "macOS reports exactly the system default");
        assert!(devices[0].id.is_empty(), "empty id = system default");
        if !unsafe { CGPreflightScreenCaptureAccess() } {
            eprintln!("skip: Screen Recording not granted for the test binary");
            return;
        }
        let ring = Arc::new(Mutex::new(VecDeque::new()));
        let (stream, _tap) = open_stream(ring.clone()).expect("open stream");
        start_or_stop_capture(&stream, true).expect("start capture");
        std::thread::sleep(Duration::from_secs(2));
        let _ = start_or_stop_capture(&stream, false);
        let got = ring.lock().len();
        drop(stream);
        assert!(got > 0, "no audio samples arrived within 2s");
    }
}
