/**
 * Backfill `subMaps` (ASCII sub-map overworld footprints) into already-crawled
 * `_gridmaps/*.json` artifacts, WITHOUT re-downloading the gifs.
 *
 * Fresh crawls bake `subMaps` in `buildGridMap`, but artifacts crawled before that
 * lack it — and the footprint source (`_wikitext/vorlage/kachelkarte.wiki`) is NOT
 * shipped in the KB tarball, so the footprint has to live inside the grid artifact.
 * This reads the local imagemap wikitext, recomputes each region's footprints from
 * the artifact's own origin/tile grid, and rewrites the JSON in place. Idempotent.
 *
 * Run: `npm run enrich:gridmaps`
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { parseImagemaps } from "../nav/grid/imagemap.js";
import { subMapFootprints } from "../nav/grid/tileGrid.js";
import type { GridMap } from "../nav/grid/types.js";

const KACHELKARTE = "_wikitext/vorlage/kachelkarte.wiki";
const norm = (s: string) => s.split("/").pop()!.replace(/\.md$/, "").replace(/^kompass-/, "").toLowerCase();
const deYear = (s: string) => norm(s.replace(/\s*\d{4}$/, ""));

async function main() {
  const root = path.resolve(config.kbDir);
  const kk = path.join(root, KACHELKARTE);
  if (!existsSync(kk)) { console.error(`[enrich] ${KACHELKARTE} not found — run a crawl first`); process.exit(1); }
  const blocks = parseImagemaps(await readFile(kk, "utf8"));
  const dir = path.join(root, config.gridMapsSubdir);
  for (const e of await readdir(dir)) {
    if (!e.endsWith(".json")) continue;
    const file = path.join(dir, e);
    const grid = JSON.parse(await readFile(file, "utf8")) as GridMap;
    const block =
      blocks.find((b) => norm(b.region) === norm(grid.region)) ??
      blocks.find((b) => deYear(b.region) === norm(grid.region));
    if (!block) { console.warn(`[enrich] no imagemap block for ${grid.region} — skipped`); continue; }
    // The artifact tiles are native-pixel; imagemap rects are display-pixel. Scale to
    // native using the artifact's own tile grid (gif width ≈ origin + cols·tile).
    const scale = block.displayWidth ? (grid.origin + grid.cols * grid.tileSize) / block.displayWidth : 1;
    const rects = scale === 1 ? block.rects : block.rects.map((r) => ({
      ...r, x1: r.x1 * scale, y1: r.y1 * scale, x2: r.x2 * scale, y2: r.y2 * scale,
    }));
    const subMaps = subMapFootprints(rects, grid.cols, grid.rows, grid.origin, grid.tileSize);
    if (!subMaps.length) { console.log(`[enrich] ${grid.region}: no sub-map footprints`); continue; }
    grid.subMaps = subMaps;
    await writeFile(file, JSON.stringify(grid));
    console.log(`[enrich] ${grid.region}: ${subMaps.length} sub-map footprint(s) → ${e}`);
  }
}

main().catch((err) => { console.error("[enrich] failed:", err); process.exit(1); });
