/**
 * Parser for MediaWiki `<imagemap>` blocks in `Vorlage:Kachelkarte`.
 *
 * These blocks are the reliable, structured source of per-tile links on the
 * overworld gifs: each `rect x1 y1 x2 y2 [[Target|Label]]` marks a pixel region
 * (a tile) that links to a city / ASCII page. We extract them at crawl time and
 * bake them into the shipped grid artifact, because the wikitext itself is NOT
 * shipped to the MCP (`build:data` excludes `_wikitext`).
 */

import { slug } from "../../crawler/okf.js";

export interface ImagemapRect {
  x1: number; y1: number; x2: number; y2: number;
  /** Slugged target page (e.g. "foo-ling-yoo"), or null for a same-image anchor. */
  target: string | null;
  /** Heading anchor on the target (or same image), or null. */
  anchor: string | null;
  /** Human label shown on hover / used as the gateway room name. */
  label: string;
}

export interface ImagemapBlock {
  /** Region key from `{{#ifeq:{{{1}}}|<Region>|…}}`, e.g. "Asia". */
  region: string;
  /** Gif filename from the `Image:<Name>.gif` line, e.g. "Asia.gif". */
  image: string;
  /** Declared display width in px (`Image:X.gif|556px|…`), or null for native.
   *  imagemap rect coords are in THIS coordinate space, so a value ≠ the gif's
   *  native width means the rects must be scaled before snapping to tiles. */
  displayWidth: number | null;
  rects: ImagemapRect[];
}

const BLOCK_RE =
  /\{\{#ifeq:\s*\{\{\{1\}\}\}\s*\|\s*([^|]+?)\s*\|\s*<imagemap>([\s\S]*?)<\/imagemap>/g;
const IMAGE_RE = /^\s*(?:Image|Datei|File):\s*([^|\n]+?\.(?:gif|png|jpe?g))\s*(?:\|\s*(\d+)px)?/im;
const RECT_RE = /^\s*rect\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\[\[([^\]]+)\]\]/i;

/** Turn a wiki link body ("Page#Anchor|Label" / "#Anchor|Label" / "Page") into
 *  { target, anchor, label }. Category links (":Kategorie:X") are kept as their
 *  slugged concept id so region-overview maps still resolve. */
export function parseLink(body: string): { target: string | null; anchor: string | null; label: string } {
  const bar = body.indexOf("|");
  const linkPart = (bar >= 0 ? body.slice(0, bar) : body).trim();
  const label = (bar >= 0 ? body.slice(bar + 1) : linkPart).trim();
  const hash = linkPart.indexOf("#");
  let page = (hash >= 0 ? linkPart.slice(0, hash) : linkPart).trim();
  const anchor = hash >= 0 ? linkPart.slice(hash + 1).trim() || null : null;
  if (!page) return { target: null, anchor, label }; // same-image anchor (point of interest)
  let target: string;
  const cat = /^:?(Kategorie|Category):(.+)$/i.exec(page);
  if (cat) target = `kategorie/${slug(cat[2])}`;
  else target = slug(page.replace(/^:/, ""));
  return { target: target || null, anchor, label };
}

export function parseImagemaps(wikitext: string): ImagemapBlock[] {
  const out: ImagemapBlock[] = [];
  for (const m of wikitext.matchAll(BLOCK_RE)) {
    const region = m[1].trim();
    const body = m[2];
    const img = IMAGE_RE.exec(body);
    if (!img) continue;
    const rects: ImagemapRect[] = [];
    for (const line of body.split("\n")) {
      const r = RECT_RE.exec(line);
      if (!r) continue; // `poly`/`desc`/`Image` lines ignored — poly are big region shapes
      const { target, anchor, label } = parseLink(r[5]);
      rects.push({
        x1: +r[1], y1: +r[2], x2: +r[3], y2: +r[4],
        target, anchor, label,
      });
    }
    if (rects.length) out.push({ region, image: img[1].trim(), displayWidth: img[2] ? +img[2] : null, rects });
  }
  return out;
}
