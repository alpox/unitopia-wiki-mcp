/**
 * OKF (de)serialization for marcopolo maps. The crawler converts a page's HTML to
 * an `McMap` (extract.ts) and stores it as an OKF markdown document — the same
 * on-disk format the rest of the knowledgebase uses — under
 * `_marcopolo/<region>/<slug>.md`. The graph pipeline then reads it back from
 * that OKF file (never from HTML at runtime): `parseMcOkf` reconstructs the
 * `McMap` so `buildMcGraph` works unchanged. See [[marcopolo-secondary-maps]].
 *
 * The body keeps three sections so the map round-trips losslessly:
 *   - a ```text fenced block: the ASCII grid (bare glyphs, spacing-faithful),
 *   - "## Legende": one bullet per label (`x` = description · linked pages),
 *   - "## Verbindungen": per-cell cross-page links as `Z<row> S<col>` + target.
 */
import { slug as okfSlug } from "../../crawler/okf.js";
import type { McMap, McLegendEntry, McCellLink } from "./extract.js";

/** Bundle-relative OKF path for a marcopolo page basename in a region. */
export function mcConceptId(region: string, pageBasename: string): string {
  return `_marcopolo/${okfSlug(region)}/${okfSlug(pageBasename)}`;
}
const mdLink = (region: string, page: string) => `[${page}](/${mcConceptId(region, page)}.md)`;
/** Recover a page basename (as used for portals) from an OKF `/_marcopolo/…` href. */
const pageOfHref = (href: string) => decodeURIComponent(href.split("/").pop() ?? "").replace(/\.md$/, "");

const climbHintsOf = (desc: string) => [...new Set([...desc.matchAll(/\[([\^v<>])\]/g)].map((m) => m[1]))];

/** Render an `McMap` as an OKF markdown body (frontmatter is added by the caller). */
export function mcMapToOkfBody(m: McMap): string {
  const lines: string[] = [];
  lines.push(`# ${m.title}`, "");
  lines.push("*Sekundärkarte von marcopolo.copete.de — älter als das Wiki, ergänzt aber Lücken der Wiki-Karte.*", "");
  lines.push("```text", m.ascii, "```", "");

  lines.push("## Legende", "");
  for (const [label, e] of Object.entries(m.legend)) {
    const pages = e.pages.length ? `  ·Karten: ${e.pages.map((p) => mdLink(m.region, p)).join(", ")}` : "";
    lines.push(`- \`${label}\` = ${e.desc}${pages}`);
  }
  lines.push("");

  if (m.cellLinks.length) {
    lines.push("## Verbindungen", "");
    for (const l of m.cellLinks) lines.push(`- Z${l.row} S${l.col} \`${l.label}\` → ${mdLink(m.region, l.page)}`);
    lines.push("");
  }
  return lines.join("\n");
}

const FENCE_RE = /```(?:text)?\n([\s\S]*?)\n```/;
const LEGEND_RE = /^- `([^`]+)` = (.*)$/;
const CONN_RE = /^- Z(\d+) S(\d+) `([^`]+)` → \[[^\]]+\]\((\/[^)]+)\)/;
const TITLE_RE = /^#\s+(.+)$/m;

/**
 * Reconstruct an `McMap` from its OKF markdown. `region`/`slug` come from the
 * file's path (the ingest walks `_marcopolo/<region>/<slug>.md`); `sourceUrl`
 * from the frontmatter `resource:` when available.
 */
export function parseMcOkf(md: string, region: string, slug: string, sourceUrl = ""): McMap {
  const ascii = FENCE_RE.exec(md)?.[1] ?? "";
  const title = TITLE_RE.exec(md.replace(/^---[\s\S]*?---/, ""))?.[1]?.trim() ?? slug;

  const legend: Record<string, McLegendEntry> = {};
  const cellLinks: McCellLink[] = [];
  const pages = new Set<string>();
  let section = "";
  for (const raw of md.split("\n")) {
    if (/^##\s+Legende/i.test(raw)) { section = "legend"; continue; }
    if (/^##\s+Verbindungen/i.test(raw)) { section = "conn"; continue; }
    if (/^#/.test(raw)) { section = ""; continue; }

    if (section === "legend") {
      const m = LEGEND_RE.exec(raw);
      if (!m) continue;
      const label = m[1];
      // Split the appended "·Karten: [X](/…)" tail from the plain description.
      const [descPart, tail = ""] = m[2].split(/\s*·Karten:\s*/);
      const linkPages = [...tail.matchAll(/\]\((\/[^)]+)\)/g)].map((mm) => pageOfHref(mm[1]));
      const desc = descPart.trim();
      legend[label] = { label, desc, pages: [...new Set(linkPages)], climbHints: climbHintsOf(desc) };
      linkPages.forEach((p) => pages.add(p));
    } else if (section === "conn") {
      const m = CONN_RE.exec(raw);
      if (!m) continue;
      const page = pageOfHref(m[4]);
      cellLinks.push({ row: +m[1], col: +m[2], label: m[3], page });
      pages.add(page);
    }
  }

  const crossPages = [...pages].filter((p) => p !== slug);
  return { slug, region, title, ascii, legend, cellLinks, crossPages, sourceUrl };
}
