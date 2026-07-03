/**
 * Crawl-time step: turn the wiki's raster overworld gifs into parsed, routable
 * `GridMap` artifacts on disk.
 *
 * Reads the `<imagemap>` blocks from the already-crawled `Vorlage:Kachelkarte`
 * wikitext (the reliable per-tile link source), downloads each region's gif,
 * decodes + classifies it into a tile grid, and writes a self-contained JSON
 * (drives routing) plus an ASCII render (for the `map` MCP tool / review).
 *
 * The gif binary is parsed-and-discarded. Both artifacts live under
 * `_gridmaps/`, which the KB tarball ships but the RAG/nav scanners skip.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { SiteInfo } from "./mediaWikiClient.js";
import { fetchImage } from "./mediaWikiClient.js";
import { parseImagemaps } from "../nav/grid/imagemap.js";
import { decodeGif } from "../nav/grid/gifDecode.js";
import { buildGridMap } from "../nav/grid/tileGrid.js";
import { renderGridAscii } from "../nav/grid/gridRouter.js";
import type { GridMap } from "../nav/grid/types.js";
import { slug } from "./okf.js";

/** Where the Kachelkarte imagemap wikitext was archived by the crawler. */
const KACHELKARTE = "_wikitext/vorlage/kachelkarte.wiki";

/** Kachelkarte region keys whose display name differs (year-suffixed variants). */
const DISPLAY_NAME: Record<string, string> = {
  Midgard2012: "Midgard",
  Gallien2012: "Gallien",
  Dörrland2012: "Dörrland",
  Inseln2012: "Nordische Inseln",
};
/** Clean display name for a Kachelkarte region key. */
const displayName = (key: string) => DISPLAY_NAME[key] ?? key.replace(/\s*\d{4}$/, "").trim();

/** Build grid-map artifacts for the configured overworld regions. Non-fatal:
 *  logs and skips a region on any failure so a crawl is never broken by it. */
export async function buildGridMaps(bundleDir: string, site: SiteInfo): Promise<void> {
  const wtPath = path.join(bundleDir, KACHELKARTE);
  if (!existsSync(wtPath)) {
    console.warn(`[grid] ${KACHELKARTE} not found — run a crawl first; skipping grid maps`);
    return;
  }
  const blocks = parseImagemaps(await readFile(wtPath, "utf8"));
  const byRegion = new Map(blocks.map((b) => [b.region, b]));
  const outDir = path.join(bundleDir, config.gridMapsSubdir);
  await mkdir(outDir, { recursive: true });

  for (const region of config.gridMapRegions) {
    const block = byRegion.get(region);
    if (!block) { console.warn(`[grid] region "${region}" not in Kachelkarte — skipped`); continue; }
    try {
      const name = displayName(region);
      const base = slug(name);
      const bytes = await fetchImage(site, block.image);
      const gif = decodeGif(bytes);
      const grid = buildGridMap(name, gif, block.rects, block.displayWidth);
      // Flat artifact filenames (grid.page is namespaced "karte/<base>").
      await writeFile(path.join(outDir, `${base}.json`), JSON.stringify(grid));
      await writeFile(path.join(outDir, `${base}.md`), gridMarkdown(grid));
      console.log(`[grid] ${name}: ${grid.cols}x${grid.rows} tiles, ${grid.gateways.length} gateways → ${base}.json`);
    } catch (err) {
      console.warn(`[grid] failed for "${region}" (${block.image}): ${err}`);
    }
  }
}

/** Human-readable ASCII render wrapped as a small markdown doc. */
function gridMarkdown(grid: GridMap): string {
  return `# ${grid.region} (Übersichtskarte)\n\nRasterkarte, ${grid.cols}×${grid.rows} Felder (ein Feld = ein Raum).\n\n\`\`\`\n${renderGridAscii(grid)}\n\`\`\`\n`;
}
