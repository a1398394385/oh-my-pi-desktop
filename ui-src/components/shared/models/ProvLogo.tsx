// Provider logo: inline SVG (simple-icons / logos via PROV_LOGOS) or a favicon
// data URI, rendered at one fixed size so every vendor slot lines up. Providers
// without an asset fall back to the legacy glyph (PROV_IC).
import { PROV_LOGOS } from "../../../../ui/prov-logos";
import { PROV_IC } from "./providers";

const SIZE = 16;
const LOGOS: Record<string, string> = PROV_LOGOS;

export default function ProvLogo({ id, fallback, size = SIZE }: { id: string; fallback?: string; size?: number }) {
  const asset = LOGOS[id] ?? (fallback ? LOGOS[fallback] : undefined);
  const glyph = PROV_IC[id] ?? "✦";
  if (!asset) return <span className="pv-ic">{glyph}</span>;
  if (asset.startsWith("data:")) return <img className="pv-logo" src={asset} width={size} height={size} alt="" />;
  return (
    <span
      className="pv-ic"
      style={{ display: "inline-flex", width: size, height: size, alignItems: "center", justifyContent: "center" }}
      dangerouslySetInnerHTML={{ __html: asset }}
    />
  );
}
