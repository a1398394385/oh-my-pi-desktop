// The sigil card (/ @ $) is rendered by LexicalTypeaheadMenuPlugin, but its open
// flag reaches the plugins through a React state mirror (Composer's taOpen ->
// typeaheadOpenRef), which lags the render by a frame and goes stale when the
// option list reloads. Keys that belong to the card ask the DOM instead: while
// the card is on screen, Enter must accept a candidate, never send the prompt.
export function paletteCardOpen(): boolean {
  return !!document.querySelector(".menu.palette.open");
}