// Form pictures for the DOM card: the renderer loads `data:`/`http(s)` sources only,
// so the model's inline `<svg>` and workspace paths are resolved here, where the host
// can read files. A picture that will not load keeps its block and the card shows its
// alt text — the same degradation the TUI's media note reports.
import { loadFormImage, svgMedia, type FormMedia } from "@oh-my-pi/pi-tui/html-form/media";
import type { FormBlock, HtmlForm } from "@oh-my-pi/pi-tui/html-form/parse";

export async function resolveFormMedia(form: HtmlForm, cwd: string, signal?: AbortSignal): Promise<HtmlForm> {
  const dataUri = (media: FormMedia) => `data:${media.mime};base64,${Buffer.from(media.bytes).toString("base64")}`;
  const sections = await Promise.all(
    form.sections.map(async (section) => ({
      ...section,
      blocks: await Promise.all(
        section.blocks.map(async (block): Promise<FormBlock> => {
          if (block.kind === "svg") return { kind: "image", src: dataUri(svgMedia(block.markup)), alt: block.alt };
          if (block.kind !== "image" || /^(https?:|data:)/i.test(block.src)) return block;
          return loadFormImage(block.src, { cwd, signal }).then(
            (media) => ({ kind: "image" as const, src: dataUri(media), alt: block.alt }),
            () => block,
          );
        }),
      ),
    })),
  );
  return { ...form, sections };
}
