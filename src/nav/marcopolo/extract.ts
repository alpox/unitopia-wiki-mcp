/**
 * Parse a marcopolo.copete.de map page into a structured `McMap` — the ASCII
 * grid, the legend (letter → name/links/climb-hints), per-cell cross-page links,
 * and the set of pages this one connects to.
 *
 * marcopolo maps are NOT MediaWiki: they are hand-written static HTML where the
 * map lives in the first `<table><td>` cell, drawn with `<font color=…>` spans
 * for colour, `&nbsp;` for horizontal spacing and `<br>` for row breaks. Single
 * letters are the room labels (a letter may repeat as several distinct rooms),
 * hyperlinked labels (`<a href="Orkberge.html">P</a>`) mean the tile continues
 * onto that page, and a legend below the table names every letter. There is no
 * compass legend — direction comes from grid geometry plus flow arrows
 * (`v ^ < >`, dotted `..>` currents). See [[marcopolo-secondary-maps]].
 *
 * Pure + synchronous so it can be unit-tested against saved HTML fixtures; the
 * crawler (src/crawler/marcopolo.ts) does the fetching and hands raw HTML here.
 */

export interface McCellLink {
  row: number;
  col: number;
  label: string;
  /** Target page basename without `.html` (e.g. "Orkberge"). */
  page: string;
}
export interface McLegendEntry {
  label: string;
  desc: string;
  /** Cross-page basenames referenced from this legend entry. */
  pages: string[];
  /** Climb/movement hints drawn in the description as [^] [v] [<] [>]. */
  climbHints: string[];
}
export interface McMap {
  slug: string;
  region: string;
  title: string;
  /** Reconstructed ASCII grid, newline-separated, spacing-faithful. */
  ascii: string;
  legend: Record<string, McLegendEntry>;
  cellLinks: McCellLink[];
  /** All linked map basenames (from cells and legend), de-duplicated. */
  crossPages: string[];
  sourceUrl: string;
}

const HREF_RE = /href="([^"]*)"/i;

/** Decode the handful of HTML entities that appear in these pages. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, "&"); // last, so "&amp;nbsp;" style double-encodes are safe
}

/** Strip `<font …>`/`</font>` (colour only — no layout) but keep everything else. */
const stripFont = (s: string): string => s.replace(/<\/?font[^>]*>/gi, "");

/** Basename of a raw href value (e.g. `../Vaniorh.html` → `Vaniorh`), or null if
 *  it is not an `.html` page link. */
function hrefBase(hrefValue: string): string | null {
  const path = hrefValue.replace(/[?#].*$/, "");
  if (!/\.html$/i.test(path)) return null;
  const base = path.split("/").pop() ?? "";
  return decodeURIComponent(base.replace(/\.html$/i, ""));
}

/** Basename from an `<a …>` tag string. */
function tagPage(tag: string): string | null {
  const m = HREF_RE.exec(tag);
  return m ? hrefBase(m[1]) : null;
}

/**
 * Turn one `<br>`-delimited HTML line into its plain text plus the column of any
 * hyperlinked label. Font tags are already stripped; `<a>` tags are consumed
 * left-to-right so a link's column reflects the decoded text before it.
 */
function parseLine(html: string): { text: string; links: { col: number; label: string; page: string }[] } {
  // Source indentation after a `<br>` (newline + leading spaces) is NOT map
  // spacing — HTML collapses it. Real spacing is `&nbsp;` and literal single
  // spaces inside the line. Drop newline+indent runs; keep the rest verbatim.
  let s = html.replace(/\n[ \t]*/g, "");
  let out = "";
  const links: { col: number; label: string; page: string }[] = [];
  const re = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    out += decodeEntities(s.slice(last, m.index));
    const label = decodeEntities(m[1].replace(/<[^>]+>/g, "")).trim();
    const page = tagPage(m[0]);
    if (page && label) links.push({ col: out.length, label, page });
    out += decodeEntities(m[1].replace(/<[^>]+>/g, ""));
    last = re.lastIndex;
  }
  out += decodeEntities(s.slice(last));
  return { text: out, links };
}

/** Extract the innerHTML of the first `<table>`'s first `<td>` — the map cell. */
function firstCellHtml(html: string): string | null {
  const table = /<table[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/i.exec(html);
  return table ? table[1] : null;
}

/** The legend block: everything after the map table, before the tracking script. */
function legendHtml(html: string): string {
  const afterTable = html.replace(/^[\s\S]*<\/table>/i, "");
  return afterTable.replace(/<!--\s*MARKER[\s\S]*$/i, "").replace(/<script[\s\S]*$/i, "");
}

function parseLegend(html: string): { legend: Record<string, McLegendEntry>; pages: string[] } {
  const legend: Record<string, McLegendEntry> = {};
  const pages = new Set<string>();
  // Entries look like:  <font …>X =</font> description text …<br>
  // Split on <br>, then match a leading "LABEL =" (LABEL = a single letter/digit
  // run, optionally colour-wrapped). Continuation lines (indented sub-bullets of
  // a multi-part entry, e.g. Bach's "-im westlichen Feld …") append to the last.
  const raw = stripFont(html).split(/<br\s*\/?>/i);
  let lastLabel: string | null = null;
  for (const seg0 of raw) {
    const segHtml = seg0.replace(/\n[ \t]*/g, "");
    const links = [...segHtml.matchAll(/href="([^"]*)"/gi)]
      .map((mm) => hrefBase(mm[1]))
      .filter((p): p is string => !!p);
    const text = decodeEntities(segHtml.replace(/<[^>]+>/g, "")).trim();
    const head = /^([A-Za-z0-9]{1,2})\s*=\s*(.*)$/.exec(text);
    const climbHints = [...text.matchAll(/\[([\^v<>])\]/g)].map((h) => h[1]);
    if (head) {
      const label = head[1];
      const entry = legend[label] ?? { label, desc: "", pages: [], climbHints: [] };
      entry.desc = (entry.desc ? entry.desc + " " : "") + head[2].trim();
      entry.pages.push(...links);
      entry.climbHints.push(...climbHints);
      legend[label] = entry;
      lastLabel = label;
    } else if (lastLabel && text) {
      const entry = legend[lastLabel];
      entry.desc += " " + text;
      entry.pages.push(...links);
      entry.climbHints.push(...climbHints);
    } else {
      lastLabel = null;
    }
    links.forEach((p) => pages.add(p));
  }
  for (const e of Object.values(legend)) {
    e.pages = [...new Set(e.pages)];
    e.climbHints = [...new Set(e.climbHints)];
  }
  return { legend, pages: [...pages] };
}

const TITLE_RE = /<title>([\s\S]*?)<\/title>/i;

/**
 * @param html   raw page HTML (already decoded from windows-1252 to a JS string)
 * @param region region name, e.g. "Vaniorh"
 * @param slug   page basename without `.html`, e.g. "Wasserfall"
 */
export function extractMcMap(html: string, region: string, slug: string, sourceUrl: string): McMap | null {
  const cell = firstCellHtml(html);
  if (!cell) return null;

  const rowsHtml = cell.split(/<br\s*\/?>/i);
  const gridRows: string[] = [];
  const cellLinks: McCellLink[] = [];
  for (const rowHtml of rowsHtml) {
    const { text, links } = parseLine(stripFont(rowHtml));
    const row = gridRows.length;
    for (const l of links) cellLinks.push({ row, col: l.col, label: l.label, page: l.page });
    gridRows.push(text.replace(/\s+$/, ""));
  }
  // Trim leading/trailing all-blank rows the table markup adds.
  while (gridRows.length && gridRows[0].trim() === "") { gridRows.shift(); shiftRows(cellLinks); }
  while (gridRows.length && gridRows[gridRows.length - 1].trim() === "") gridRows.pop();

  const { legend, pages: legendPages } = parseLegend(legendHtml(html));
  const title = decodeEntities((TITLE_RE.exec(html)?.[1] ?? slug).replace(/<[^>]+>/g, "")).trim();
  const crossPages = [...new Set([...cellLinks.map((c) => c.page), ...legendPages])].filter((p) => p !== slug);

  return { slug, region, title, ascii: gridRows.join("\n"), legend, cellLinks, crossPages, sourceUrl };
}

/** After dropping the first grid row, shift every cell link up one row. */
function shiftRows(links: McCellLink[]): void {
  for (const l of links) l.row -= 1;
}
