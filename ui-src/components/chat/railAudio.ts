// Windows-only bridge between the Rust shell's WASAPI spectrum capture and the
// message rail's music-reactive ticks.
//
// The Rust side (src-tauri/src/audio.rs) streams `rail-spectrum` frames (32
// log-spaced bands, normalized 0..1) at ~30 fps while capture runs. This module
// owns the lifecycle — restore the pref, start/stop the capture, and hand the
// newest windowed spectrum to subscribers on rAF so tick repaints stay on the
// frame budget instead of running at the capture thread's cadence.
//
// Best-effort by design: outside Tauri (browser `?preview=1` debugging) there is
// no capture and `isAudioCapturing()` stays false; failures log and go quiet — a
// missing music effect must never block the chat.
import { useAppStore } from "../../store";
import { saveUiPrefs } from "../../appearance";

/** Band count pushed by the Rust FFT (src-tauri/src/audio.rs BANDS). */
export const SPECTRUM_BANDS = 32;
/** Spectrum frames averaged per repaint. Deliberately tiny: a long window
 * flattens the very transients the effect lives on (a 30-frame window at 30 fps
 * is a full second of averaging — drums disappear into a slow envelope).
 * 2 frames is just enough to drop single-frame FFT noise without smearing beats. */
const SMOOTH_FRAMES = 2;

export interface AudioDevice {
  id: string;
  name: string;
}

export interface Spectrum {
  bands: Float32Array;
  peak: number;
  /** False once capture stops: silence still arrives as a live frame with all
   * bands at 0, so consumers need to tell "quiet music" from "no capture". */
  active: boolean;
}

interface SpectrumPayload {
  bands: number[];
  peak: number;
}

type SpectrumListener = (s: Spectrum) => void;

/** Newest-last ring of raw frames; older than SMOOTH_FRAMES is dropped. */
const ring: SpectrumPayload[] = [];
const listeners = new Set<SpectrumListener>();
let unlisten: (() => void) | null = null;
/** In-flight listener registration; two concurrent starts share one promise. */
let pendingListen: Promise<void> | null = null;
let raf = 0;
/** Latest smoothed frame, republished each animation frame while capture runs. */
let latest: Spectrum = { bands: new Float32Array(SPECTRUM_BANDS), peak: 0, active: false };

/** Rolling-window average of the buffered frames; this is what ticks render from. */
function smooth(): Spectrum {
  const n = Math.min(ring.length, SMOOTH_FRAMES);
  const bands = new Float32Array(SPECTRUM_BANDS);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const frame = ring[ring.length - 1 - i];
    for (let b = 0; b < SPECTRUM_BANDS && b < frame.bands.length; b++) bands[b] += frame.bands[b];
    peak += frame.peak;
  }
  if (n > 0) {
    for (let b = 0; b < SPECTRUM_BANDS; b++) bands[b] /= n;
    peak /= n;
  }
  // A frame only counts as live once the capture is actually streaming; before
  // the first one arrives (or after stopping) the rail stays pointer-driven.
  return { bands, peak, active: unlisten !== null && n > 0 };
}

function tick(): void {
  raf = 0;
  if (!unlisten && listeners.size === 0) return;
  latest = smooth();
  for (const fn of listeners) fn(latest);
  raf = requestAnimationFrame(tick);
}

/** Subscribe to spectrum updates (one call per animation frame while capturing). */
export function onSpectrum(fn: SpectrumListener): () => void {
  listeners.add(fn);
  if (!raf) raf = requestAnimationFrame(tick);
  return () => listeners.delete(fn);
}

export function currentSpectrum(): Spectrum {
  return latest;
}

export async function listDevices(): Promise<AudioDevice[]> {
  const core = window.__TAURI__?.core;
  if (!core?.invoke) return [];
  try {
    return await core.invoke<AudioDevice[]>("audio_devices");
  } catch (err) {
    console.warn("audio_devices:", err);
    return [];
  }
}

/**
 * Start (or restart) loopback capture on `deviceId`, streaming spectrum frames as
 * `rail-spectrum` events. An empty `deviceId` means the console default endpoint.
 *
 * The event listener is registered exactly once and never torn down between
 * device switches: `audio_start` drops the previous capture thread (Rust side),
 * so switching devices only changes what the frames contain. Re-registering per
 * start would race when two starts interleave across the await and leak a ghost
 * listener still feeding the ring.
 */
export async function startAudioCapture(deviceId: string): Promise<void> {
  const core = window.__TAURI__?.core;
  if (!core?.invoke) return;
  await ensureListener();
  try {
    await core.invoke("audio_start", { deviceId });
  } catch (err) {
    console.warn("audio_start:", err);
  }
}

/** Register the spectrum listener once; a concurrent second call joins the first. */
async function ensureListener(): Promise<void> {
  if (unlisten) return;
  if (pendingListen) return pendingListen;
  const events = window.__TAURI__?.event;
  if (!events?.listen) return;
  pendingListen = events
    .listen("rail-spectrum", (e) => {
      const payload = e.payload as SpectrumPayload | undefined;
      if (!payload?.bands || payload.bands.length < SPECTRUM_BANDS) return;
      ring.push(payload);
      if (ring.length > SMOOTH_FRAMES) ring.shift();
    })
    .then((off) => {
      unlisten = off as () => void;
      pendingListen = null;
    });
  await pendingListen;
}

/** Stop capture and clear the buffer. Safe to call when not running. */
export async function stopAudioCapture(): Promise<void> {
  ring.length = 0;
  latest = { bands: new Float32Array(SPECTRUM_BANDS), peak: 0, active: false };
  const core = window.__TAURI__?.core;
  if (!core?.invoke) return;
  try {
    await core.invoke("audio_stop");
  } catch (err) {
    console.warn("audio_stop:", err);
  }
  unlisten?.();
  unlisten = null;
  pendingListen = null;
  // Push an inactive frame so subscribers hand the widths back to the pointer:
  // a stopped effect that looks identical to "quiet music" would otherwise
  // leave the rail highlight-only with nothing driving it.
  latest = { bands: new Float32Array(SPECTRUM_BANDS), peak: 0, active: false };
  for (const fn of listeners) fn(latest);
}

/** Whether a capture is currently streaming frames to the webview. */
export function isAudioCapturing(): boolean {
  return unlisten !== null;
}

/** Persisted pair (host-side validated on write): off / system default device. */
export function readAudioPref(): { enabled: boolean; deviceId: string } {
  const prefs = useAppStore.getState().uiPrefs;
  return { enabled: prefs.railMusic === true, deviceId: prefs.railMusicDevice ?? "" };
}

export function writeAudioPref(enabled: boolean, deviceId: string): void {
  useAppStore.setState((st) => ({ uiPrefs: { ...st.uiPrefs, railMusic: enabled, railMusicDevice: deviceId } }));
  saveUiPrefs();
}

/** Apply the persisted pref to the capture (startup path and settings toggle). */
export async function syncAudioToPref(): Promise<void> {
  const { enabled, deviceId } = readAudioPref();
  if (enabled) await startAudioCapture(deviceId);
  else await stopAudioCapture();
}