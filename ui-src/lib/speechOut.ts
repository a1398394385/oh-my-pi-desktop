// UI-side speech output on the system speechSynthesis: the bundled Kokoro has
// no Chinese G2P while OS voices cover both languages with zero download, so
// the host forwards tts_* frames and this module turns them into speech.
//
// Pipeline: deltas accumulate in a buffer; every sentence boundary (or the
// hard cap, matching Kokoro's phoneme limit concerns) releases one utterance
// onto a serial queue — utterances never overlap. Markdown noise is stripped
// (fenced code blocks are skipped wholesale, inline markup unwrapped, links
// reduced to their label). tts_stop cancels everything (user message / abort
// mid-turn); duck lowers the volume of later utterances while the user is
// dictating so replies do not talk over them.
//
// Voice selection: the persisted override (localStorage "omp-voice-tts",
// written by the settings page picker) wins; otherwise the first voice whose
// lang matches the UI language (zh → any zh-*, en → en-*). Voices load
// asynchronously — getVoices() may be empty until onvoiceschanged fires.

/** Hard cap per utterance in characters (sentence splitting keeps segments short; this is the ceiling). */
const MAX_SEGMENT = 280;
/** localStorage key for the user-picked voice name. */
const VOICE_PREF_KEY = "omp-voice-tts";

const synth: SpeechSynthesis | undefined = typeof window !== "undefined" ? window.speechSynthesis : undefined;

let buffer = "";
let ducked = false;
/** Serial playback chain: each queued utterance awaits the previous one. */
let chain: Promise<void> = Promise.resolve();
let voicesReady = false;
const voiceWaiters: Array<() => void> = [];

if (synth) {
  const probe = () => {
    if (synth.getVoices().length > 0) {
      voicesReady = true;
      voiceWaiters.splice(0).forEach((w) => w());
    }
  };
  probe();
  synth.addEventListener("voiceschanged", probe);
}

/** Wait (bounded) for the system voice list; resolves false when unavailable. */
async function ensureVoices(timeoutMs = 2500): Promise<boolean> {
  if (!synth) return false;
  if (voicesReady || synth.getVoices().length > 0) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(synth.getVoices().length > 0), timeoutMs);
    voiceWaiters.push(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function pickVoice(): SpeechSynthesisVoice | null {
  if (!synth) return null;
  const voices = synth.getVoices();
  if (voices.length === 0) return null;
  const overrideName = localStorage.getItem(VOICE_PREF_KEY);
  if (overrideName) {
    const hit = voices.find((v) => v.name === overrideName);
    if (hit) return hit;
  }
  const uiLang = localStorage.getItem("omp-ui-settings");
  const preferZh = !uiLang || uiLang.includes("zh");
  const prefix = preferZh ? "zh" : "en";
  return voices.find((v) => v.lang.toLowerCase().startsWith(prefix)) ?? voices[0] ?? null;
}

/** Markdown noise → readable prose: skip fenced code, unwrap inline markup, reduce links to labels. */
function speakable(text: string): string {
  const withoutFences = text.replace(/```[\s\S]*?(```|$)/g, " ");
  return withoutFences
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_#>~]+/g, "")
    .replace(/\|/g, " ")
    .trim();
}

function speakSegment(text: string): void {
  const clean = speakable(text);
  if (!clean || !synth) return;
  const utter = new SpeechSynthesisUtterance(clean);
  const voice = pickVoice();
  if (voice) {
    utter.voice = voice;
    utter.lang = voice.lang;
  }
  utter.volume = ducked ? 0.25 : 1;
  chain = chain.then(
    () =>
      new Promise<void>((resolve) => {
        // Safari/WebKit never fires onend for some utterances: also resolve
        // when the queue drains (speaking+pending both go false after the end)
        const watch = setInterval(() => {
          if (!synth.speaking && !synth.pending) {
            clearInterval(watch);
            resolve();
          }
        }, 250);
        utter.onend = () => {
          clearInterval(watch);
          resolve();
        };
        utter.onerror = () => {
          clearInterval(watch);
          resolve();
        };
        synth.speak(utter);
      }),
  );
}

/** Find the longest speakable sentence cut in the buffer (sentence punctuation or newline). */
function sentenceCut(): number {
  const m = buffer.match(/^[\s\S]*?[。！？!?\.](\s|$)/);
  if (m && m[0].trim().length >= 2 && m[0].length <= MAX_SEGMENT) return m[0].length;
  const nl = buffer.indexOf("\n");
  if (nl > 0 && nl <= MAX_SEGMENT) return nl + 1;
  return -1;
}

/** Streaming delta from the host bridge (tts_delta frame). */
export function feedTtsDelta(text: string): void {
  if (!synth) return;
  buffer += text;
  if (buffer.length > MAX_SEGMENT * 4) {
    // Unpunctuated wall of text (CJK without punctuation): speak it in cap-sized slices
    speakSegment(buffer.slice(0, MAX_SEGMENT));
    buffer = buffer.slice(MAX_SEGMENT);
    return;
  }
  let cut = sentenceCut();
  while (cut > 0) {
    speakSegment(buffer.slice(0, cut));
    buffer = buffer.slice(cut);
    cut = sentenceCut();
  }
}

/** Speak the buffered trailing partial now (tts_flush frame). */
export function flushTts(): void {
  if (buffer.trim()) {
    speakSegment(buffer);
    buffer = "";
  }
}

/** Silence immediately and drop everything buffered (tts_stop frame). */
export function stopTts(): void {
  buffer = "";
  if (!synth) return;
  synth.cancel();
  chain = Promise.resolve();
}

/** Lower/restore the volume of later utterances while the user is dictating. */
export function setTtsDuck(on: boolean): void {
  ducked = on;
}

/** One-shot speak (settings-page test button). Resolves false when no system voice exists. */
export async function speakNow(text: string): Promise<boolean> {
  if (!(await ensureVoices())) return false;
  buffer = "";
  speakSegment(text);
  flushTts();
  return true;
}

/** Enumerate system voices for the settings-page picker (name + lang). */
export async function listTtsVoices(): Promise<Array<{ name: string; lang: string }>> {
  if (!(await ensureVoices())) return [];
  return (synth?.getVoices() ?? []).map((v) => ({ name: v.name, lang: v.lang }));
}

/** Persist the voice override (empty string = auto by UI language). */
export function setTtsVoicePref(name: string): void {
  if (name) localStorage.setItem(VOICE_PREF_KEY, name);
  else localStorage.removeItem(VOICE_PREF_KEY);
}

export function getTtsVoicePref(): string {
  return localStorage.getItem(VOICE_PREF_KEY) ?? "";
}
