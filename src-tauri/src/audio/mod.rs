//! System-audio spectrum capture driving the message rail's music-reactive
//! ticks: WASAPI loopback on Windows, ScreenCaptureKit over the default output
//! on macOS. Each platform's capture thread feeds mono samples into the shared
//! pipeline below — a Hann-windowed radix-2 FFT, folded into [`BANDS`]
//! log-spaced bands with attack/release smoothing, emitted as a
//! [`SpectrumFrame`] roughly every 33 ms to the webview.
//!
//! Deliberately coarse: the rail needs a shape per band, not a spectrum
//! analyzer. Band 0 is the lowest frequency, so the rail reads bass at the top
//! and treble at the bottom.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use rustfft::num_complex::Complex32;
use rustfft::{Fft, FftPlanner};
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "windows")]
mod win;

#[cfg(target_os = "macos")]
use mac as platform;
#[cfg(target_os = "windows")]
use win as platform;

/// Frequency bands per frame; the frontend subsamples this down to however many
/// ticks it draws.
pub const BANDS: usize = 32;
/// Payload event name.
const EVENT: &str = "rail-spectrum";
/// Frame lifecycle event name (device opened / stream died).
const STATE_EVENT: &str = "rail-spectrum-state";
/// FFT size; 2048 at 48 kHz gives ~23.4 Hz bins, plenty for 32 log bands.
const FFT_SIZE: usize = 2048;
/// Frame cadence (~30 fps). Faster than the rail needs and slow enough to stay
/// off the UI thread's critical path.
const FRAME_MS: u64 = 33;
/// Per-band smoothing. Release trails attack so a tick snaps up on the transient
/// and eases back down, instead of the slow symmetrical ramp that made the rail
/// read as flat breathing: at 30 fps these reach ~63% of a step in 1 and 6 frames.
const ATTACK: f32 = 0.75;
const RELEASE: f32 = 0.3;
/// Band edges: 30 Hz .. 12 kHz, the span that reads well on a 3 px tick.
const BAND_LO_HZ: f32 = 30.0;
const BAND_HI_HZ: f32 = 12_000.0;
/// Noise floor: measured quiet high bands sit at ~5e-4 rms. Subtracted before
/// the log so silence renders as 0 instead of riding the log's tail.
const BAND_FLOOR: f32 = 5e-4;
/// Divisor for the compression. The curve is a power law against each band's
/// own auto-gain ceiling rather than a log: measured peaks only reach ~0.7x of
/// their ceiling, so `ln` compressed everything into the bottom fifth of the
/// scale (measured max 0.17 of 1.0). Raising to a low exponent re-expands the
/// working range so a strong hit lands near the top and quiet audio still moves.
const BAND_GAMMA: f32 = 0.7;
/// Per-band auto-gain. Each band tracks a slowly-decaying maximum of its OWN
/// history, so a band that only ever carries cymbals fills its range as well as
/// one carrying the bassline. A single shared reference could not: with the
/// ceiling pinned by the loudest band, the quieter bands were compressed to a
/// fraction of the scale and the rail read as flat.
const AGC_ATTACK: f32 = 0.5;
const AGC_RELEASE: f32 = 0.01;

/// One spectrum frame: [`BANDS`] normalized energies plus the frame's loudest
/// band, so the frontend can also scale the whole rail as one value.
#[derive(Clone, serde::Serialize)]
pub struct SpectrumFrame {
    pub bands: Vec<f32>,
    pub peak: f32,
}

/// Shared spectrum pipeline: one mono window in, normalized bands + peak out.
/// Owned by the capture thread — no interior locking.
struct Analyzer {
    window: Vec<f32>,
    fft: Arc<dyn Fft<f32>>,
    spectrum: Vec<Complex32>,
    envelope: Vec<f32>,
    bands: Vec<f32>,
    agc: Vec<f32>,
    bin_hz: f32,
}

impl Analyzer {
    fn new(sample_rate: f32) -> Self {
        Self {
            window: hann(FFT_SIZE),
            fft: FftPlanner::<f32>::new().plan_fft_forward(FFT_SIZE),
            spectrum: vec![Complex32::new(0.0, 0.0); FFT_SIZE],
            envelope: vec![0f32; BANDS],
            bands: vec![0f32; BANDS], // raw rms per band, reused every frame
            agc: vec![BAND_FLOOR * 8.0; BANDS], // per-band auto-gain ceilings
            bin_hz: sample_rate / FFT_SIZE as f32,
        }
    }

    /// Consume one mono analysis window (`mono.len() == FFT_SIZE`, short inputs
    /// zero-padded by the caller), advance the per-band envelopes, and return
    /// the frame's loudest normalized band.
    fn analyze(&mut self, mono: &[f32]) -> f32 {
        debug_assert_eq!(mono.len(), FFT_SIZE);
        for (i, &v) in mono.iter().enumerate() {
            self.spectrum[i].re = v * self.window[i];
            self.spectrum[i].im = 0.0;
        }
        self.fft.process(&mut self.spectrum);

        let last_bin = FFT_SIZE / 2;
        let ratio = BAND_HI_HZ / BAND_LO_HZ;
        // Pass 1: raw band rms, each feeding its own auto-gain ceiling. Written in
        // place, then normalized in pass 2.
        for band in 0..BANDS {
            let f0 = BAND_LO_HZ * ratio.powf(band as f32 / BANDS as f32);
            let f1 = BAND_LO_HZ * ratio.powf((band + 1) as f32 / BANDS as f32);
            let b0 = ((f0 / self.bin_hz).floor() as usize).max(1);
            let b1 = (((f1 / self.bin_hz).ceil() as usize).min(last_bin)).max(b0 + 1);
            let mut sum = 0f32;
            for b in b0..b1.min(last_bin) {
                sum += self.spectrum[b].norm_sqr();
            }
            self.bands[band] = (sum / (b1 - b0) as f32).sqrt();
            // Ceiling snaps up, bleeds down slowly; floored so a silent stretch
            // cannot inflate the noise into fake motion.
            let ceiling = self.agc[band];
            self.agc[band] = if self.bands[band] > ceiling {
                AGC_ATTACK * self.bands[band] + (1.0 - AGC_ATTACK) * ceiling
            } else {
                AGC_RELEASE * self.bands[band] + (1.0 - AGC_RELEASE) * ceiling
            };
        }

        // Pass 2: power-law compression between the floor and each band's own ceiling.
        let mut peak = 0f32;
        for band in 0..BANDS {
            let ref_level = self.agc[band].max(BAND_FLOOR * 8.0);
            let ratio = ((self.bands[band] - BAND_FLOOR).max(0.0)) / ref_level;
            let norm = ratio.powf(BAND_GAMMA).clamp(0.0, 1.0);
            peak = peak.max(norm);
            self.envelope[band] = if norm > self.envelope[band] {
                ATTACK * norm + (1.0 - ATTACK) * self.envelope[band]
            } else {
                RELEASE * norm + (1.0 - RELEASE) * self.envelope[band]
            };
        }
        peak
    }
}

/// Managed capture state: the stop flag is polled by the capture thread, and
/// holding the handle here is what lets a restart join the old thread.
#[derive(Default)]
pub struct AudioState {
    inner: Mutex<Option<Capture>>,
}

struct Capture {
    stop: Arc<AtomicBool>,
    // Wrapped so Drop can move the handle out; a bare JoinHandle would make
    // `self` partially moved inside drop.
    handle: Option<JoinHandle<()>>,
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        // The thread checks the flag between frames; on macOS the stop also
        // shuts the SCStream down (bounded by the stop completion timeout).
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// Output device the user can pick from the settings page.
#[derive(serde::Serialize, Clone)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
}

/// Enumerate capture sources for the settings page (platform-specific meaning
/// of "device": render endpoints on Windows, the single system default output
/// on macOS).
#[tauri::command]
pub fn audio_devices() -> Result<Vec<AudioDevice>, String> {
    platform::list_devices()
}

/// Start (or restart) loopback capture, streaming spectrum frames as
/// `rail-spectrum` events. Dropping the previous capture joins its thread, so
/// restarting never stacks threads.
#[tauri::command]
pub fn audio_start(app: AppHandle, state: tauri::State<'_, AudioState>, device_id: String) -> Result<(), String> {
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let handle = std::thread::Builder::new()
        .name("rail-audio".into())
        .spawn(move || capture_loop(app, thread_stop, device_id))
        .map_err(|e| e.to_string())?;
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    *guard = Some(Capture { stop, handle: Some(handle) });
    Ok(())
}

/// Stop capture. Safe to call when nothing is running.
#[tauri::command]
pub fn audio_stop(state: tauri::State<'_, AudioState>) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}

/// Blocking capture loop: open the capture, then pump frames until the stop
/// flag is set or the stream dies (device unplugged, endpoint invalidated).
fn capture_loop(app: AppHandle, stop: Arc<AtomicBool>, device_id: String) {
    match platform::run_capture(&app, &stop, &device_id) {
        Ok(()) => {}
        Err(e) => {
            eprintln!("[audio] capture failed: {e}");
            let _ = app.emit(
                STATE_EVENT,
                serde_json::json!({ "active": false, "error": e }),
            );
        }
    }
    let _ = app.emit(STATE_EVENT, serde_json::json!({ "active": false }));
}

fn hann(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / n as f32).cos()))
        .collect()
}
