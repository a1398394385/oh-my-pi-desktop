//! Windows capture: WASAPI loopback over a render endpoint. A render endpoint
//! opened in loopback mode — `Direction::Render` into `Direction::Capture`
//! makes `initialize_client` set `AUDCLNT_STREAMFLAGS_LOOPBACK`, so the stream
//! carries whatever the endpoint is playing.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};
use wasapi::*;

use super::{Analyzer, AudioDevice, EVENT, FFT_SIZE, FRAME_MS, SpectrumFrame, STATE_EVENT};

/// Enumerate render endpoints (the loopback sources). Disabled or unplugged
/// endpoints are skipped — they can only fail on selection.
pub fn list_devices() -> Result<Vec<AudioDevice>, String> {
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

pub fn run_capture(app: &AppHandle, stop: &AtomicBool, device_id: &str) -> Result<(), String> {
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

    let mut analyzer = Analyzer::new(sample_rate);
    let mut mono = vec![0f32; FFT_SIZE];
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
        let peak = analyzer.analyze(&mono);

        if last_emit.elapsed() >= Duration::from_millis(FRAME_MS) {
            last_emit = Instant::now();
            let frame = SpectrumFrame { bands: analyzer.envelope.clone(), peak };
            if app.emit(EVENT, &frame).is_err() {
                // Webview gone (app shutting down): stop capturing.
                break;
            }
        }
    }
    client.stop_stream().ok();
    Ok(())
}
