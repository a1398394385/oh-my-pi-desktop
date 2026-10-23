// Provider logo: inline SVG (simple-icons / logos via PROV_LOGOS) or a favicon
// data URI, rendered at one fixed size so every vendor slot lines up. Providers
// without an asset fall back to the legacy glyph (PROV_IC).
import { useEffect, useState } from "react";
import { PROV_IC } from "./providers";

const SIZE = 16;
const NO_LOGOS: Record<string, string> = {};

// prov-logos is ~100KB of inline SVG/base64 assets: loaded on first ProvLogo
// mount instead of statically, so it never enters the startup closure. Cached
// module-side; later mounts render synchronously.
let provLogos: Record<string, string> | null = null;
let provLogosLoad: Promise<Record<string, string>> | null = null;

export default function ProvLogo({ id, fallback, size = SIZE }: { id: string; fallback?: string; size?: number }) {
  const [logos, setLogos] = useState<Record<string, string>>(provLogos ?? NO_LOGOS);
  useEffect(() => {
    if (provLogos) return;
    provLogosLoad ??= import("../../../../ui/prov-logos").then((m) => {
      provLogos = m.PROV_LOGOS;
      return provLogos;
    });
    let alive = true;
    void provLogosLoad.then((loaded) => {
      if (alive) setLogos(loaded);
    });
    return () => {
      alive = false;
    };
  }, []);
  const asset = logos[id] ?? (fallback ? logos[fallback] : undefined);
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
