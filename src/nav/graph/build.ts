/**
 * Build the persistent unified navigation graph per region and write it to
 * `_navgraph/<region>.json`. Each graph merges the wiki map-pages of that region
 * (authoritative) with the crawled marcopolo maps (priority-2 fallback). This is
 * the single serialized IR consumed by BOTH the router (fallback edges) and a
 * future custom renderer. See [[marcopolo-secondary-maps]].
 */
import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pageGraphIR } from "../mapGraph.js";
import { parseMcOkf } from "../marcopolo/okf.js";
import { buildMcGraph } from "../marcopolo/graph.js";
import { mergeGraphs, type GraphPart } from "./merge.js";
import { slug as okfSlug } from "../../crawler/okf.js";
import type { UnifiedGraph } from "./types.js";

const MC_SUBDIR = "_marcopolo";
const NAVGRAPH_SUBDIR = "_navgraph";
const RESOURCE_RE = /^resource:\s*"?([^"\n]+)"?/m;
const TAGS_RE = /^tags:\s*\[([^\]]*)\]/m;
const regionTags = (md: string) =>
  (TAGS_RE.exec(md)?.[1] ?? "")
    .split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter((t) => t && t !== "Karte" && t !== "marcopolo");

/** A page has a routable ASCII map (same cheap pre-filter the nav index uses). */
const hasMap = (md: string) => /[o~]--|--[o~]|\n\s*[o~]\s/.test(md);

async function collectWikiMd(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!e.name.startsWith("_")) await collectWikiMd(path.join(dir, e.name), out); }
    else if (e.name.endsWith(".md") && e.name !== "index.md" && e.name !== "log.md") out.push(path.join(dir, e.name));
  }
  return out;
}

export async function buildRegionGraphs(kbDir: string, log: (m: string) => void = () => {}): Promise<number> {
  const mcRoot = path.join(kbDir, MC_SUBDIR);
  if (!existsSync(mcRoot)) { log("[navgraph] no _marcopolo/ — skipping"); return 0; }

  // 1. Marcopolo graphs grouped by region (slug → parts), plus display name.
  const mcByRegion = new Map<string, GraphPart[]>();
  const displayName = new Map<string, string>();
  for (const regionSlug of await readdir(mcRoot)) {
    const rdir = path.join(mcRoot, regionSlug);
    if (!(await stat(rdir)).isDirectory()) continue;
    for (const f of await readdir(rdir)) {
      if (!f.endsWith(".md") || f === "index.md") continue;
      const md = await readFile(path.join(rdir, f), "utf8");
      const region = regionTags(md)[0] ?? regionSlug;
      displayName.set(regionSlug, region);
      const mc = parseMcOkf(md, region, f.replace(/\.md$/, ""), RESOURCE_RE.exec(md)?.[1] ?? "");
      const g = buildMcGraph(mc);
      (mcByRegion.get(regionSlug) ?? mcByRegion.set(regionSlug, []).get(regionSlug)!).push({ nodes: g.nodes, edges: g.edges });
    }
  }

  // 2. Wiki map-pages grouped by the SAME region slugs (only regions that have
  //    marcopolo data — those are the ones the fallback can enrich).
  const wikiByRegion = new Map<string, GraphPart[]>();
  for (const file of await collectWikiMd(kbDir)) {
    const md = await readFile(file, "utf8");
    if (!hasMap(md)) continue;
    const slugs = regionTags(md).map(okfSlug).filter((s) => mcByRegion.has(s));
    if (!slugs.length) continue;
    const conceptId = path.relative(kbDir, file).replace(/\.md$/, "").split(path.sep).join("/");
    const region = regionTags(md)[0] ?? slugs[0];
    const ir = pageGraphIR(md, conceptId, region);
    if (!ir.nodes.length) continue;
    for (const s of new Set(slugs)) (wikiByRegion.get(s) ?? wikiByRegion.set(s, []).get(s)!).push(ir);
  }

  // 3. Merge + write one artifact per region.
  const outDir = path.join(kbDir, NAVGRAPH_SUBDIR);
  await mkdir(outDir, { recursive: true });
  let written = 0;
  for (const [regionSlug, mcParts] of mcByRegion) {
    const region = displayName.get(regionSlug) ?? regionSlug;
    const graph: UnifiedGraph = mergeGraphs(region, wikiByRegion.get(regionSlug) ?? [], mcParts);
    await writeFile(path.join(outDir, `${regionSlug}.json`), JSON.stringify(graph));
    const mc = graph.edges.filter((e) => e.origin === "marcopolo").length;
    log(`  ✓ ${regionSlug}: ${graph.nodes.length} nodes, ${graph.edges.length} edges (${mc} marcopolo)`);
    written++;
  }
  log(`[navgraph] wrote ${written} region graphs → ${outDir}`);
  return written;
}
