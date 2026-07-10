/**
 * Parse a marcopolo.copete.de map page into a structured `McMap` — the ASCII
 * grid, the legend (letter → name/links/climb-hints), per-cell cross-page links,
 * and the set of pages this one connects to.
 *
 * marcopolo maps are NOT MediaWiki: they are hand-written static HTML where the
 * map lives in the first `<table><td>` cell, drawn with `<font color=…>` spans
 * for colour, `&nbsp;` for horizontal spacing and `<br>` for row breaks. Single
 * letters are the room labels — and CRUCIALLY a letter's `<font color>` is part
 * of its identity: the same letter in a different colour is a DIFFERENT room
 * (e.g. Orkberge draws `W` cyan = "runter zum Wasserfall klettern", amber =
 * "alter Planwagen", green = "Wald"). So both the legend and each map cell carry
 * a colour, and rooms are keyed by (letter, colour). Hyperlinked labels
 * (`<a href="Orkberge.html">P</a>`) mean the tile continues onto that page.
 * There is no compass legend — direction comes from grid geometry plus flow
 * arrows (`v ^ < >`, dotted `..>` currents). See [[marcopolo-secondary-maps]].
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
export interface McCellColor {
  row: number;
  col: number;
  /** Normalized hex colour (uppercase, no `#`) of the glyph at this cell. */
  color: string;
}
export interface McLegendEntry {
  label: string;
  /** Normalized hex colour of the legend head — part of the room's identity. */
  color: string;
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
  /** Legend entries keyed by (label, colour) — several per letter are normal. */
  legend: McLegendEntry[];
  /** Colour of each map cell whose label letter is AMBIGUOUS (drawn in more than
   *  one colour); disambiguates which legend room that cell is. Unambiguous
   *  labels take their single legend entry's colour and are omitted here. */
  cellColors: McCellColor[];
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

const CSS_COLORS: Record<string, string> = {
  blue: "0000FF", red: "FF0000", green: "008000", black: "000000", white: "FFFFFF",
  yellow: "FFFF00", lime: "00FF00", aqua: "00FFFF", cyan: "00FFFF", magenta: "FF00FF",
  fuchsia: "FF00FF", gray: "808080", grey: "808080", silver: "C0C0C0", orange: "FFA500",
  maroon: "800000", olive: "808000", navy: "000080", teal: "008080", purple: "800080",
};
/** Canonicalize a colour attribute to uppercase 6-digit hex (or "" if absent). */
export function normColor(raw: string | null | undefined): string {
  if (!raw) return "";
  const c = raw.trim().toLowerCase().replace(/^#/, "");
  if (CSS_COLORS[c]) return CSS_COLORS[c];
  if (/^[0-9a-f]{6}$/.test(c)) return c.toUpperCase();
  if (/^[0-9a-f]{3}$/.test(c)) return c.split("").map((x) => x + x).join("").toUpperCase();
  return c.toUpperCase();
}

/** Basename of a raw href value (e.g. `../Vaniorh.html` → `Vaniorh`), or null if
 *  it is not an `.html` page link. */
function hrefBase(hrefValue: string): string | null {
  const path = hrefValue.replace(/[?#].*$/, "");
  if (!/\.html$/i.test(path)) return null;
  const base = path.split("/").pop() ?? "";
  return decodeURIComponent(base.replace(/\.html$/i, ""));
}

/**
 * Stream the map cell's HTML into a colour-aware grid: the plain-text rows, a
 * parallel colour per cell (from the active `<font color>` stack, which persists
 * across `<br>` row breaks — the outer font sets the base colour), and any
 * hyperlinked-label cells. Source newline+indent between tags is collapsed by
 * HTML, so it is dropped; real spacing is `&nbsp;`/literal spaces and `<br>`.
 */
function parseCell(cellHtml: string): { rows: string[]; colorRows: string[][]; cellLinks: McCellLink[] } {
  const html = cellHtml.replace(/\r?\n[ \t]*/g, ""); // drop collapsed source indentation
  const rows: string[] = [];
  const colorRows: string[][] = [];
  const cellLinks: McCellLink[] = [];
  let row: string[] = [], rowColors: string[] = [];
  const stack: string[] = [];
  const cur = () => (stack.length ? stack[stack.length - 1] : "");
  let linkPage: string | null = null, linkStartCol = -1, linkText = "";
  const newline = () => { rows.push(row.join("")); colorRows.push(rowColors); row = []; rowColors = []; };
  const emit = (ch: string) => {
    if (linkPage) { if (linkStartCol < 0) linkStartCol = row.length; linkText += ch; }
    row.push(ch); rowColors.push(cur());
  };
  const tokRe = /<br\s*\/?>|<font\b[^>]*>|<\/font>|<a\b[^>]*>|<\/a>|<[^>]+>|&[a-zA-Z]+;|&#\d+;|[\s\S]/gi;
  let m: RegExpExecArray | null;
  while ((m = tokRe.exec(html))) {
    const t = m[0];
    if (/^<br/i.test(t)) { newline(); continue; }
    if (/^<font/i.test(t)) { const cm = /\bcolor=\"?([^\"\s>]+)\"?/i.exec(t); stack.push(cm ? normColor(cm[1]) : cur()); continue; }
    if (/^<\/font/i.test(t)) { stack.pop(); continue; }
    if (/^<a\b/i.test(t)) { const hm = HREF_RE.exec(t); linkPage = hm ? hrefBase(hm[1]) : null; linkStartCol = -1; linkText = ""; continue; }
    if (/^<\/a/i.test(t)) { if (linkPage && linkText.trim() && linkStartCol >= 0) cellLinks.push({ row: rows.length, col: linkStartCol, label: linkText.trim(), page: linkPage }); linkPage = null; continue; }
    if (t[0] === "<") continue;                        // any other tag
    if (t[0] === "&") { for (const ch of decodeEntities(t)) emit(ch); continue; } // entity
    emit(t);                                            // ordinary character
  }
  newline();
  return { rows, colorRows, cellLinks };
}

/** Extract the innerHTML of the first `<table>`'s first `<td>` — the map cell. */
function firstCellHtml(html: string): string | null {
  const table = /<table[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/i.exec(html);
  return table ? table[1] : null;
}

/** The block after the map table, before the tracking script — the legend on
 *  DETAIL pages (Orkberge). On region OVERWORLD pages (Midgard, Vaniorh) the map
 *  and legend share the single `<td>`, so this comes back empty; see splitCell. */
function afterTableHtml(html: string): string {
  const afterTable = html.replace(/^[\s\S]*<\/table>/i, "");
  return afterTable.replace(/<!--\s*MARKER[\s\S]*$/i, "").replace(/<script[\s\S]*$/i, "");
}

// A label letter includes German umlauts (Midgard's legend has `Ä =`, `ä =`).
const LABEL_CH = "A-Za-z0-9ÄÖÜäöüß";
const LEGEND_HEAD_RE = new RegExp(`<font\\b[^>]*\\bcolor=[^>]*>\\s*[${LABEL_CH}]{1,2}\\s*=`, "i");
const LEGEND_MARKER_RE = /<font\b[^>]*>\s*(?:Sehenswertes|Zeichenerkl|Legende|Erkl[aä]rung|Bewohner|Personen)/i;

/**
 * Separate the map HTML from the legend HTML, handling both page layouts:
 *  - DETAIL pages keep the legend AFTER `</table>` → use that, map = whole cell.
 *  - OVERWORLD pages put both inside the one `<td>`, the legend introduced by a
 *    "Sehenswertes:"/"Zeichenerklärung" header (or just the first `X =` head) →
 *    split the cell there so the legend isn't parsed as map rows and vice versa.
 */
function splitCell(cell: string, afterTable: string): { mapHtml: string; legendSrc: string } {
  if (LEGEND_HEAD_RE.test(afterTable)) return { mapHtml: cell, legendSrc: afterTable };
  const head = LEGEND_HEAD_RE.exec(cell);
  const mark = LEGEND_MARKER_RE.exec(cell);
  const idx = Math.min(head ? head.index : Infinity, mark ? mark.index : Infinity);
  if (!isFinite(idx)) return { mapHtml: cell, legendSrc: afterTable };
  return { mapHtml: cell.slice(0, idx), legendSrc: cell.slice(idx) };
}

function parseLegend(html: string): { legend: McLegendEntry[]; pages: string[] } {
  const legend: McLegendEntry[] = [];
  const pages = new Set<string>();
  // Entries look like:  <font color="RRGGBB">X =</font> description …<br>
  // Split on <br>; a head is a colour-wrapped "LABEL =" (the colour is part of
  // the room's identity). Continuation lines (indented sub-bullets, e.g. Bach's
  // "-im westlichen Feld …") append to the previous entry.
  let last: McLegendEntry | null = null;
  for (const seg0 of html.split(/<br\s*\/?>/i)) {
    const segHtml = seg0.replace(/\r?\n[ \t]*/g, "");
    const links = [...segHtml.matchAll(/href="([^"]*)"/gi)].map((mm) => hrefBase(mm[1])).filter((p): p is string => !!p);
    const text = decodeEntities(segHtml.replace(/<[^>]+>/g, "")).trim();
    const headText = new RegExp(`^([${LABEL_CH}]{1,2})\\s*=\\s*(.*)$`).exec(text);
    const climbHints = [...text.matchAll(/\[([\^v<>])\]/g)].map((h) => h[1]);
    if (headText) {
      // Colour of the font span that wraps this "LABEL =" head.
      const headColor = new RegExp(`<font\\b[^>]*\\bcolor=\"?([^\"\\s>]+)\"?[^>]*>\\s*${headText[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`, "i").exec(segHtml);
      const entry: McLegendEntry = { label: headText[1], color: normColor(headColor?.[1]), desc: headText[2].trim(), pages: [...links], climbHints: [...climbHints] };
      legend.push(entry); last = entry;
    } else if (last && text) {
      last.desc += " " + text; last.pages.push(...links); last.climbHints.push(...climbHints);
    } else last = null;
    links.forEach((p) => pages.add(p));
  }
  for (const e of legend) { e.pages = [...new Set(e.pages)]; e.climbHints = [...new Set(e.climbHints)]; }
  return { legend, pages: [...pages] };
}

const TITLE_RE = /<title>([\s\S]*?)<\/title>/i;

/** Labels drawn in more than one colour — the ones whose map cells need an
 *  explicit per-cell colour to know which room they are. */
export function ambiguousLabels(legend: McLegendEntry[]): Set<string> {
  const byLabel = new Map<string, Set<string>>();
  for (const e of legend) (byLabel.get(e.label) ?? byLabel.set(e.label, new Set()).get(e.label)!).add(e.color);
  return new Set([...byLabel].filter(([, cs]) => cs.size > 1).map(([l]) => l));
}

/**
 * @param html   raw page HTML (already decoded from windows-1252 to a JS string)
 * @param region region name, e.g. "Vaniorh"
 * @param slug   page basename without `.html`, e.g. "Wasserfall"
 */
export function extractMcMap(html: string, region: string, slug: string, sourceUrl: string): McMap | null {
  const cell = firstCellHtml(html);
  if (!cell) return null;
  const { mapHtml, legendSrc } = splitCell(cell, afterTableHtml(html));

  const { rows: gridRows, colorRows, cellLinks } = parseCell(mapHtml);
  for (const r of gridRows) void r; // (rows kept verbatim; trailing trim below)
  // Trim trailing whitespace per row, then leading/trailing all-blank rows,
  // shifting cell links + colours to match.
  let top = 0, bot = gridRows.length;
  while (top < bot && gridRows[top].trim() === "") top++;
  while (bot > top && gridRows[bot - 1].trim() === "") bot--;
  const rows = gridRows.slice(top, bot).map((r) => r.replace(/\s+$/, ""));
  const colors = colorRows.slice(top, bot);
  for (const l of cellLinks) l.row -= top;
  const links = cellLinks.filter((l) => l.row >= 0 && l.row < rows.length);

  const { legend, pages: legendPages } = parseLegend(legendSrc);
  const ambiguous = ambiguousLabels(legend);
  const labelCh = new RegExp(`[${LABEL_CH}]`);
  const cellColors: McCellColor[] = [];
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      const ch = rows[r][c];
      if (labelCh.test(ch) && ambiguous.has(ch) && colors[r]?.[c]) cellColors.push({ row: r, col: c, color: colors[r][c] });
    }
  }

  const title = decodeEntities((TITLE_RE.exec(html)?.[1] ?? slug).replace(/<[^>]+>/g, "")).trim();
  const crossPages = [...new Set([...links.map((c) => c.page), ...legendPages])].filter((p) => p !== slug);

  return { slug, region, title, ascii: rows.join("\n"), legend, cellColors, cellLinks: links, crossPages, sourceUrl };
}
