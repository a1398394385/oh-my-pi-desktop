//! System-audio spectrum capture (Windows-only WASAPI loopback) driving the
//! message rail's music-reactive ticks.
//!
//! A render endpoint is opened in loopback mode — `Direction::Render` into
//! `Direction::Capture` makes `initialize_client` set
//! `AUDCLNT_STREAMFLAGS_LOOPBACK`, so the stream carries whatever the endpoint is
//! playing. One thread pulls f32 frames, runs a Hann-windowed radix-2 FFT, folds
//! the bins into [`BANDS`] log-spaced bands with attack/release smoothing, and
//! emits a [`SpectrumFrame`] roughly every 33 ms to the webview.
//!
//! Deliberately coarse: the rail needs a shape per band, not a spectrum
//! analyzer. Band 0 is the lowest frequency, so the rail reads bass at the top
//! and treble at the bottom.
#![cfg(windows)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use rustfft::num_complex::Complex32;
use rustfft::FftPlanner;
use tauri::{AppHandle, Emitter};
use wasapi::*;

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
        // The thread checks the flag between buffers and on the sleep path, so
        // this join is bounded by one buffer period (~20 ms).
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

/// Enumerate render endpoints (the loopback sources). Disabled or unplugged
/// endpoints are skipped — they can only fail on selection.
#[tauri::command]
pub fn audio_devices() -> Result<Vec<AudioDevice>, String> {
    let _ = initialize_mta().ok();
    let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
    let collection = enumerator
        .get_device_collection(&Direction::Render)
        .map_err(|e| e.to_string())?;
    let count = collection.get_nbr_devices().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for i in 0..count {
        let Ok(device) = collection.get_device_at_index(i) else {
            continue;
        };
        if !matches!(device.get_state(), Ok(DeviceState::Active)) {
            continue;
        }
        let (Ok(id), Ok(name)) = (device.get_id(), device.get_friendlyname()) else {
            continue;
        };
        out.push(AudioDevice { id, name });
    }
    Ok(out)
}

/// Start (or restart) loopback capture, streaming spectrum frames as
/// `rail-spectrum` events. An empty `device_id` means the console default render
/// endpoint. Dropping the previous capture joins its thread, so restarting never
/// stacks threads.
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

/// Blocking capture loop: open loopback, then pump buffers until the stop flag is
/// set or the stream dies (device unplugged, endpoint invalidated).
fn capture_loop(app: AppHandle, stop: Arc<AtomicBool>, device_id: String) {
    match run_capture(&app, &stop, &device_id) {
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

fn run_capture(app: &AppHandle, stop: &AtomicBool, device_id: &str) -> Result<(), String> {
    let _ = initialize_mta().ok();
    let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
    let device = if device_id.is_empty() {
        enumerator
            .get_default_device(&Direction::Render)
            .map_err(|e| e.to_string())?
    } else {
        enumerator.get_device(device_id).map_err(|e| e.to_string())?
    };
    let name = device.get_friendlyname().unwrap_or_default();
    let _ = app.emit(STATE_EVENT, serde_json::json!({ "active": true, "device": name }));

    let mut client = device.get_iaudioclient().map_err(|e| e.to_string())?;
    let mix = client.get_mixformat().map_err(|e| e.to_string())?;
    // Polling mode, not Events: no event handle to keep alive for the thread's
    // lifetime, and loopback buffers are small enough that a short sleep between
    // polls beats a kernel event round-trip.
    let mode = StreamMode::PollingShared {
        autoconvert: true,
        buffer_duration_hns: 200_000,
    };
    if client.initialize_client(&mix, &Direction::Capture, &mode).is_err() {
        // Some endpoints reject their own mix format under loopback (seen on AMD
        // HD devices); the engine's format converter accepts this one instead.
        let fallback = WaveFormat::new(32, 32, &SampleType::Float, 48000, 2, None);
        client
            .initialize_client(&fallback, &Direction::Capture, &mode)
            .map_err(|e| format!("{e} (mix format also rejected)"))?;
    }
    client.start_stream().map_err(|e| e.to_string())?;
    let capture = client.get_audiocaptureclient().map_err(|e| e.to_string())?;

    let sample_rate = mix.get_samplespersec() as f32;
    let channels = (mix.get_nchannels() as usize).max(1);
    let block_align = mix.get_blockalign() as usize;
    // Interleaved f32 frames assumed after initialize_client; the fallback above
    // also lands on 32-bit float. Anything else would shift the mixdown, so bail
    // loudly instead of visualizing noise.
    if mix.get_bitspersample() != 32 {
        client.stop_stream().ok();
        return Err(format!(
            "endpoint mixes at {} bits; only 32-bit float is supported",
            mix.get_bitspersample()
        ));
    }

    let window = hann(FFT_SIZE);
    let fft = FftPlanner::<f32>::new().plan_fft_forward(FFT_SIZE);
    let mut mono = vec![0f32; FFT_SIZE];
    let mut spectrum: Vec<Complex32> = vec![Complex32::new(0.0, 0.0); FFT_SIZE];
    let mut envelope = vec![0f32; BANDS];
    let mut bands = vec![0f32; BANDS]; // raw rms per band, reused every frame
    let mut agc = vec![BAND_FLOOR * 8.0; BANDS]; // per-band auto-gain ceilings
    let mut buffer = vec![0u8; FFT_SIZE * block_align.max(4)];
    let mut last_emit = Instant::now();

    while !stop.load(Ordering::Relaxed) {
        let Ok(Some(packets)) = capture.get_next_packet_size() else {
            // Endpoint invalidated (unplug, driver reset). Reconnecting from here
            // would fight the frontend's own start/stop, so report and unwind.
            return Err("capture stream failed (device changed?)".into());
        };
        if packets == 0 {
            std::thread::sleep(Duration::from_millis(10));
            continue;
        }
        let Ok((frames, _)) = capture.read_from_device(&mut buffer) else {
            return Err("capture read failed".into());
        };

        // Mono mixdown into the analysis window, zero-padded when the buffer is
        // shorter than the FFT window.
        mono.fill(0.0);
        let samples = (frames as usize).saturating_mul(channels).min(FFT_SIZE);
        for i in 0..samples {
            let off = i * 4;
            if off + 4 > buffer.len() {
                break;
            }
            mono[i] = f32::from_le_bytes([
                buffer[off],
                buffer[off + 1],
                buffer[off + 2],
                buffer[off + 3],
            ]);
        }
        for i in 0..FFT_SIZE {
            let v = mono[i] * window[i];
            spectrum[i].re = v;
            spectrum[i].im = 0.0;
        }
        fft.process(&mut spectrum);

        let bin_hz = sample_rate / FFT_SIZE as f32;
        let last_bin = FFT_SIZE / 2;
        let ratio = BAND_HI_HZ / BAND_LO_HZ;
        // Pass 1: raw band rms, each feeding its own auto-gain ceiling. Written in
        // place, then normalized in pass 2.
        for band in 0..BANDS {
            let f0 = BAND_LO_HZ * ratio.powf(band as f32 / BANDS as f32);
            let f1 = BAND_LO_HZ * ratio.powf((band + 1) as f32 / BANDS as f32);
            let b0 = ((f0 / bin_hz).floor() as usize).max(1);
            let b1 = (((f1 / bin_hz).ceil() as usize).min(last_bin)).max(b0 + 1);
            let mut sum = 0f32;
            for b in b0..b1.min(last_bin) {
                sum += spectrum[b].norm_sqr();
            }
            bands[band] = (sum / (b1 - b0) as f32).sqrt();
            // Ceiling snaps up, bleeds down slowly; floored so a silent stretch
            // cannot inflate the noise into fake motion.
            let ceiling = agc[band];
            agc[band] = if bands[band] > ceiling {
                AGC_ATTACK * bands[band] + (1.0 - AGC_ATTACK) * ceiling
            } else {
                AGC_RELEASE * bands[band] + (1.0 - AGC_RELEASE) * ceiling
            };
        }

        // Pass 2: power-law compression between the floor and each band's own ceiling.
        let mut peak = 0f32;
        for band in 0..BANDS {
            let ref_level = agc[band].max(BAND_FLOOR * 8.0);
            let ratio = ((bands[band] - BAND_FLOOR).max(0.0)) / ref_level;
            let norm = ratio.powf(BAND_GAMMA).clamp(0.0, 1.0);
            peak = peak.max(norm);
            envelope[band] = if norm > envelope[band] {
                ATTACK * norm + (1.0 - ATTACK) * envelope[band]
            } else {
                RELEASE * norm + (1.0 - RELEASE) * envelope[band]
            };
        }

        if last_emit.elapsed() >= Duration::from_millis(FRAME_MS) {
            last_emit = Instant::now();
            let frame = SpectrumFrame { bands: envelope.clone(), peak };
            if app.emit(EVENT, &frame).is_err() {
                // Webview gone (app shutting down): stop capturing.
                break;
            }
        }
    }
    client.stop_stream().ok();
    Ok(())
}

fn hann(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / n as f32).cos()))
        .collect()
}