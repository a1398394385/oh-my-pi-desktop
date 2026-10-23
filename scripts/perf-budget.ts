#!/usr/bin/env bun
// Startup-closure budget gate (Batch 0 of the perf spec).
//
// What "startup closure" means here: every chunk reachable from the entry via
// STATIC imports (BFS over import/export-from specifiers). Dynamic import()
// targets are deliberately excluded -- they cost nothing until first use.
//
//  1. BFS the static import graph from ui/dist's entry chunk.
//  2. If .map siblings exist, attribute each generated line by column interval
//     back to source modules (via @jridgewell/trace-mapping), clustered by
//     node_modules package / repo directory. ui:build does not emit maps; build
//     with `OMP_PERF_MAPS=1 bun run ui:build` to get them ("hidden" maps leave
//     chunk bytes identical to the shipped build).
//  3. Diff against docs/architecture/perf-budget-baseline.json; exit 1 when the
//     closure grows beyond the budget tolerance.
//
// Read-only by default; `--update-baseline` rewrites the baseline JSON.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { TraceMap, decodedMappings } from "@jridgewell/trace-mapping";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DIST = join(REPO_ROOT, "ui/dist");
const BASELINE_PATH = join(REPO_ROOT, "docs/architecture/perf-budget-baseline.json");
const UPDATE = process.argv.includes("--update-baseline");
const TOLERANCE = 1.02; // fail when closure bytes exceed baseline * 2%

// Static ESM edges only. Boundary guard rejects `t.import(` and dynamic
// import(...) because a "(" cannot start the from-clause or a bare specifier.
const STATIC_IMPORT_RE = /(?:^|[,;{}\s])(?:import|export)\s*(?:[\w$*{},\s]+?from\s*)?["']([^"']+\.(?:js|mjs))["']/g;

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + " MiB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

function entryChunk(): string {
  const indexHtml = join(DIST, "index.html");
  let entry = "assets/app.js";
  if (existsSync(indexHtml)) {
    const src = readFileSync(indexHtml, "utf8").match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1];
    if (src) entry = src.replace(/^\.\//, "");
  }
  const p = join(DIST, entry);
  if (!existsSync(p)) {
    console.error(`error: entry chunk not found: ui/dist/${entry} -- run bun run ui:build first`);
    process.exit(1);
  }
  return p;
}

function staticImports(js: string, fromDir: string): string[] {
  const out: string[] = [];
  for (const m of js.matchAll(STATIC_IMPORT_RE)) {
    const spec = m[1]!;
    if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) continue; // http:, data:, ...
    const p = resolve(fromDir, spec);
    if (p.endsWith(".js") && existsSync(p)) out.push(p);
  }
  return out;
}

function closure(entry: string): { chunks: string[]; bytes: number } {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  let bytes = 0;
  while (queue.length) {
    const p = queue.shift()!;
    const js = readFileSync(p, "utf8");
    bytes += Buffer.byteLength(js, "utf8");
    for (const dep of staticImports(js, dirname(p))) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return { chunks: [...seen], bytes };
}

function clusterOf(source: string, mapDir: string): string {
  const s = source.replace(/^\0/, "").replace(/\\/g, "/");
  if (!s || s.startsWith("<")) return "(unmapped)";
  if (s.startsWith("vite/") || s.startsWith("/@fs/") || s.startsWith("\0")) return "(build-helper)";
  const abs = s.startsWith("/") ? s : resolve(mapDir, s);
  const nm = abs.lastIndexOf("/node_modules/");
  if (nm >= 0) {
    const rest = abs.slice(nm + "/node_modules/".length).split("/");
    return rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1]}` : (rest[0] ?? "(node_modules)");
  }
  const rel = relative(REPO_ROOT, abs);
  if (rel.startsWith("..")) return "(outside-repo)";
  const parts = rel.split("/");
  // ui/ holds flat generated registries (prov-logos.js, file-icons.js, ...):
  // keep the filename so each registry is its own budget row.
  return parts.length > 1 && parts[0] === "ui" ? `ui/${parts[1]}` : (parts[0] ?? rel);
}

// Per-line column-interval attribution: each mapping owns the span up to the
// next mapping on the same generated line (last one owns the line tail).
function attribute(chunks: string[]): { clusters: Map<string, number>; mapped: number; unmapped: number } | null {
  const clusters = new Map<string, number>();
  let mapped = 0;
  let unmapped = 0;
  let sawMap = false;
  for (const chunk of chunks) {
    const mapPath = chunk + ".map";
    if (!existsSync(mapPath)) continue;
    sawMap = true;
    const js = readFileSync(chunk, "utf8");
    const lines = js.split("\n");
    const tm = new TraceMap(JSON.parse(readFileSync(mapPath, "utf8")));
    const mappings = decodedMappings(tm);
    for (let ln = 0; ln < mappings.length; ln++) {
      const segs = mappings[ln]!;
      const lineLen = lines[ln]?.length ?? 0;
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i]!;
        const end = i + 1 < segs.length ? segs[i + 1]![0] : lineLen;
        const span = Math.max(0, end - seg[0]);
        if (seg.length >= 4) {
          const cluster = clusterOf(tm.sources[seg[1]!] ?? "", dirname(mapPath));
          clusters.set(cluster, (clusters.get(cluster) ?? 0) + span);
          mapped += span;
        } else {
          unmapped += span;
        }
      }
    }
  }
  return sawMap ? { clusters, mapped, unmapped } : null;
}

type Baseline = { closure: { chunks: number; bytes: number }; attribution?: Array<{ cluster: string; bytes: number }> };

function main(): void {
  const entry = entryChunk();
  const { chunks, bytes } = closure(entry);
  const entryBytes = ((): number => {
    try {
      return readFileSync(entry).byteLength;
    } catch {
      return 0;
    }
  })();
  console.log(`startup closure: ${chunks.length} chunks, ${fmtBytes(bytes)} (${bytes} bytes)`);
  console.log(`  entry: ui/dist/${relative(DIST, entry)} (${fmtBytes(entryBytes)})`);

  const attr = attribute(chunks);
  let current: Array<{ cluster: string; bytes: number }> = [];
  if (attr) {
    current = [...attr.clusters.entries()]
      .map(([cluster, b]) => ({ cluster, bytes: b }))
      .sort((a, b) => b.bytes - a.bytes);
    const total = attr.mapped + attr.unmapped;
    console.log(
      `attribution: mapped ${fmtBytes(attr.mapped)} / unmapped ${fmtBytes(attr.unmapped)} (${((attr.mapped / Math.max(1, total)) * 100).toFixed(1)}% of generated chars)`,
    );
  } else {
    console.log("attribution: skipped (no .map siblings) -- rebuild with `OMP_PERF_MAPS=1 bun run ui:build`");
  }

  if (UPDATE) {
    writeFileSync(
      BASELINE_PATH,
      JSON.stringify({ closure: { chunks: chunks.length, bytes }, attribution: current }, null, 2) + "\n",
      "utf8",
    );
    console.log(`baseline updated: ${relative(REPO_ROOT, BASELINE_PATH)}`);
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error(`error: baseline missing: ${relative(REPO_ROOT, BASELINE_PATH)} -- run with --update-baseline`);
    process.exit(1);
  }
  const baseline: Baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  const baseBytes = baseline.closure.bytes;
  const dBytes = bytes - baseBytes;
  const dChunks = chunks.length - baseline.closure.chunks;
  console.log(
    `closure vs baseline: ${dBytes >= 0 ? "+" : ""}${fmtBytes(Math.abs(dBytes))} (${((dBytes / baseBytes) * 100).toFixed(1)}%), chunks ${dChunks >= 0 ? "+" : ""}${dChunks}`,
  );

  const baseAttr = new Map((baseline.attribution ?? []).map((r) => [r.cluster, r.bytes]));
  if (attr && baseAttr.size) {
    const rows = [...new Set([...baseAttr.keys(), ...attr!.clusters.keys()])]
      .map((cluster) => ({ cluster, base: baseAttr.get(cluster) ?? 0, cur: attr!.clusters.get(cluster) ?? 0 }))
      .sort((a, b) => Math.abs(b.cur - b.base) - Math.abs(a.cur - a.base) || b.cur - a.cur);
    console.log("");
    console.log("cluster                              baseline        current          delta");
    for (const r of rows.slice(0, 25)) {
      const d = r.cur - r.base;
      console.log(
        `${r.cluster.padEnd(36)}${String(r.base).padStart(12)}${String(r.cur).padStart(16)}${(d >= 0 ? "  +" : "  ").concat(String(d))}`,
      );
    }
  }

  if (bytes > baseBytes * TOLERANCE) {
    console.error(`FAIL: startup closure exceeds baseline by more than ${(TOLERANCE - 1) * 100}%`);
    process.exit(1);
  }
  console.log("OK: startup closure within budget");
}

main();
