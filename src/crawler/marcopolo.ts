/**
 * Crawl marcopolo.copete.de map pages and store each as an OKF markdown document
 * (NOT raw HTML) under `_marcopolo/<region>/<slug>.md`, so the marcopolo maps
 * live in the knowledgebase in the same on-disk format as the wiki pages. The
 * nav graph pipeline reads them back from OKF (never from HTML at runtime); the
 * compiled routing graph is emitted separately as JSON. See
 * [[marcopolo-secondary-maps]].
 *
 * Discovery is a polite BFS: the site's directory listing is 403, so pages are
 * found by following `.html` links within `/Karten/` from the seed(s). Pages are
 * served as windows-1252, so bytes are decoded as latin1 (correct for the umlaut
 * range these pages use).
 */
import { createHash } from "node:crypto";
import { URL } from "node:url";
import { httpGetBuffer, sleep } from "./http.js";
import { writeConcept } from "./okfWriter.js";
import { extractMcMap } from "../nav/marcopolo/extract.js";
import { mcMapToOkfBody, mcConceptId } from "../nav/marcopolo/okf.js";

const ORIGIN = "https://marcopolo.copete.de";
const KARTEN = "/Karten/";

/** Region + page slug for a `/Karten/…/X.html` URL. Depth-1 files (`Vaniorh.html`)
 *  are a region's overworld (region = basename); deeper files belong to the
 *  directory above them (`Vaniorh/Wasserfall.html` → region "Vaniorh"). */
function regionAndSlug(pathname: string): { region: string; slug: string } | null {
  const rel = pathname.replace(/^\/Karten\//i, "");
  const parts = rel.split("/").filter(Boolean);
  if (!parts.length) return null;
  const base = decodeURIComponent(parts[parts.length - 1]).replace(/\.html.*$/i, "");
  const region = parts.length >= 2 ? decodeURIComponent(parts[parts.length - 2]) : base;
  if (/^index$/i.test(base) && parts.length < 2) return null; // world index: seed only
  return { region, slug: base };
}

/** Absolute `.html` links within `/Karten/`, resolved against the page URL. */
function outLinks(html: string, pageUrl: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/href="([^"]+?\.html[^"]*)"/gi)) {
    try {
      const u = new URL(m[1], pageUrl);
      if (u.origin === ORIGIN && u.pathname.startsWith(KARTEN)) out.add(u.origin + u.pathname);
    } catch { /* skip malformed */ }
  }
  return [...out];
}

export interface CrawlOpts {
  bundleDir: string;
  seeds?: string[];
  /** Only crawl pages whose region matches (case-insensitive) — for a pilot. */
  region?: string;
  /** Safety cap on pages fetched. */
  limit?: number;
  /** Politeness delay between requests (ms). */
  delayMs?: number;
  log?: (msg: string) => void;
}

export async function crawlMarcopolo(opts: CrawlOpts): Promise<{ written: number; visited: number }> {
  const log = opts.log ?? (() => {});
  // Seed: a single region's overworld page (which links to all its detail maps)
  // when a pilot region is set, else the world index (which links to every
  // region page under /Karten/).
  const seeds = opts.seeds ??
    (opts.region ? [`${ORIGIN}${KARTEN}${opts.region}.html`] : [`${ORIGIN}/Index.html`]);
  const queue = [...seeds];
  const visited = new Set<string>();
  const wantRegion = opts.region?.toLowerCase();
  let written = 0;

  while (queue.length && visited.size < (opts.limit ?? 5000)) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    let html: string;
    try {
      const res = await httpGetBuffer(url);
      if (res.status !== 200) { log(`  ${res.status} ${url}`); continue; }
      html = res.body.toString("latin1"); // pages are windows-1252
    } catch (e) {
      log(`  ERR ${url}: ${(e as Error).message}`);
      continue;
    }
    await sleep(opts.delayMs ?? 300);

    // Enqueue newly discovered links regardless of region (so a pilot region is
    // still reachable through the world/region index pages).
    for (const link of outLinks(html, url)) if (!visited.has(link)) queue.push(link);

    const rs = regionAndSlug(new URL(url).pathname);
    if (!rs) continue;
    if (wantRegion && rs.region.toLowerCase() !== wantRegion) continue;

    const map = extractMcMap(html, rs.region, rs.slug, url);
    if (!map || !map.ascii.trim()) { log(`  no map: ${url}`); continue; }

    const body = mcMapToOkfBody(map);
    await writeConcept(opts.bundleDir, {
      conceptId: mcConceptId(rs.region, rs.slug),
      type: "Marcopolo Map",
      title: map.title || rs.slug,
      description: `Sekundärkarte (marcopolo.copete.de): ${map.title || rs.slug}`,
      resource: url,
      tags: ["Karte", rs.region, "marcopolo"],
      timestamp: new Date().toISOString(),
      revid: 0,
      namespace: 0,
      contenthash: createHash("sha256").update(body).digest("hex"),
      body,
    });
    written++;
    log(`  ✓ ${mcConceptId(rs.region, rs.slug)} (${map.crossPages.length} Verbindungen)`);
  }
  return { written, visited: visited.size };
}
