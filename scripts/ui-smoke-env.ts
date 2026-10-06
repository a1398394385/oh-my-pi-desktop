// Minimal DOM environment for source-level React regression scripts.
import { Window } from "happy-dom";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export function createSmokeWindow() {
  if (process.env.OMP_PROFILE !== "omp-desktop-test") throw new Error("UI 冒烟必须使用 OMP_PROFILE=omp-desktop-test");
  mkdirSync(join(homedir(), ".omp/profiles/omp-desktop-test/agent"), { recursive: true });
  const window = new Window({ url: "http://localhost/?preview=1" });
  Object.assign(globalThis, {
    window, document: window.document, localStorage: window.localStorage, navigator: window.navigator,
    location: window.location, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement,
    getComputedStyle: window.getComputedStyle.bind(window),
    matchMedia: window.matchMedia.bind(window), ResizeObserver: window.ResizeObserver, MutationObserver: window.MutationObserver,
    DocumentFragment: window.DocumentFragment, Text: window.Text, Selection: window.Selection, Range: window.Range,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
  });
  return window;
}
