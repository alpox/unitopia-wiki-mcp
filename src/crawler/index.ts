import { createHash } from "node:crypto";
import path from "node:path";
import { config } from "../config.js";
import {
  discover,
  contentNamespaces,
  bulkFetchPages,
  renderBatch,
  parsePage,
  pageUrl,
  BATCH_RENDER_TITLE,
  type BulkPage,
  type SiteInfo,
} from "./mediaWikiClient.js";
import { htmlToOkf } from "./htmlToOkf.js";
import { extractKenndaten } from "./templateData.js";
import { conceptIdFor, typeFor, normalizeTitle } from "./okf.js";
import {
  writeConcept,
  writeWikitext,
  removeConcept,
  writeIndexes,
  appendLog,
  type ConceptDoc,
} from "./okfWriter.js";
import { loadState, saveState } from "./state.js";
import { buildGridMaps } from "./gridMaps.js";

const DELAY_MS = Number(process.env.CRAWL_DELAY_MS ?? 250);
const BATCH_SIZE = Number(process.env.CRAWL_BATCH_SIZE ?? 50);
const CONCURRENCY = Number(process.env.CRAWL_CONCURRENCY ?? 4);

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Run `fn` over `items` with at most `size` concurrent invocations. */
async function pool<T>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

/** Pages whose templates need the real page title context (PAGENAME etc.). */
function needsSingleRender(wikitext: string): boolean {
  return /\{\{\s*(PAGENAME|FULLPAGENAME|subst:)/i.test(wikitext);
}

/** A batch render runs under the fixed `BATCH_RENDER_TITLE`, so a page whose
 *  templates resolve the page title only at render time — not visible in the
 *  top-level wikitext, e.g. Set/effect tables that build `{{<Set>/{{PAGENAME}}}}`
 *  cells — comes out wrong: the sentinel title leaks in as red-linked
 *  `…/OKF-Sammelrendern` templates. Detecting that leak lets us re-render the page
 *  individually with its real title so the effects resolve. */
function batchContextLeaked(html: string): boolean {
  return html.includes(BATCH_RENDER_TITLE);
}

async function main() {
  const full = process.argv.includes("--full");
  const singleMode = process.argv.includes("--render=server-single");
  const nsArg = process.argv.indexOf("--namespace");
  const onlyNs = nsArg >= 0 ? Number(process.argv[nsArg + 1]) : undefined;
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity;
  // --titles-file <path>: force-render exactly the newline-separated wiki titles in
  // the file (regardless of revid), for a targeted re-render of specific pages.
  const tfArg = process.argv.indexOf("--titles-file");
  let titleSet: Set<string> | null = null;
  if (tfArg >= 0) {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(process.argv[tfArg + 1], "utf8");
    titleSet = new Set(raw.split("\n").map((s) => s.trim()).filter(Boolean).map((s) => normalizeTitle(s)));
    console.log(`[crawl] --titles-file: forcing ${titleSet.size} titles`);
  }

  const bundleDir = path.resolve(config.kbDir);
  const site = await discover();
  const state = await loadState(bundleDir);
  const runStart = new Date().toISOString();

  const namespaces = onlyNs !== undefined ? [onlyNs] : contentNamespaces(site);
  console.log(`[crawl] namespaces: ${namespaces.join(", ")}`);

  // --- Pass 1: one cheap JSON pass for wikitext + revid + touched + categories.
  const allPages: BulkPage[] = [];
  for (const ns of namespaces) {
    // --limit also caps enumeration so small test runs finish quickly.
    const cap = Number.isFinite(limit) ? limit - allPages.length : Infinity;
    if (cap <= 0) break;
    const pages = await bulkFetchPages(site, ns, DELAY_MS, cap);
    console.log(`[crawl] ns ${ns}: ${pages.length} pages (bulk)`);
    allPages.push(...pages);
  }

  // Full title→concept map so cross-links resolve even to not-yet-rendered pages.
  const titleToConcept = new Map<string, string>();
  for (const p of allPages) {
    titleToConcept.set(normalizeTitle(p.title), conceptIdFor(site, p.ns, p.title));
  }
  const resolveConcept = (title: string) =>
    titleToConcept.get(normalizeTitle(title)) ?? null;

  // --- Decide which pages need (re)rendering: new or changed revid.
  const liveTitles = new Set(allPages.map((p) => normalizeTitle(p.title)));
  let toRender =
    titleSet
      ? allPages.filter((p) => titleSet!.has(normalizeTitle(p.title)))
      : full || !state.lastRun
      ? allPages
      : allPages.filter((p) => {
          const prev = state.pages[normalizeTitle(p.title)];
          return !prev || prev.revid !== p.revid;
        });
  if (Number.isFinite(limit) && toRender.length > limit) {
    toRender = toRender.slice(0, limit);
  }
  console.log(
    `[crawl] rendering ${toRender.length} of ${allPages.length} pages ` +
      `(batch=${BATCH_SIZE}, concurrency=${CONCURRENCY})`,
  );

  const logEntries: { kind: "Creation" | "Update" | "Deprecation"; line: string }[] =
    [];

  /** Convert one page's rendered HTML → OKF and persist it. */
  async function processPage(page: BulkPage, html: string): Promise<void> {
    if (!html) {
      console.warn(`[crawl] no HTML for "${page.title}" — skipped`);
      return;
    }
    const { markdown, description } = htmlToOkf(html, {
      articlePath: site.articlePath,
      absoluteUrlFor: (t) => pageUrl(site, t),
      resolveConcept,
    });
    // Recover template stats (Erfahrung, Typ, item values, …) that the rendered
    // HTML drops, so the model can ground numeric answers.
    const kenndaten = extractKenndaten(page.wikitext);
    const body = kenndaten ? `${markdown}\n\n${kenndaten}` : markdown;
    const conceptId = conceptIdFor(site, page.ns, page.title);
    const key = normalizeTitle(page.title);
    const contenthash = sha256(body);
    const prev = state.pages[key];

    await writeWikitext(bundleDir, conceptId, page.wikitext); // archival backup

    if (prev && prev.contenthash === contenthash && prev.conceptId === conceptId) {
      state.pages[key] = { ...prev, revid: page.revid };
      return; // body unchanged: leave the .md untouched (clean diffs)
    }

    const doc: ConceptDoc = {
      conceptId,
      type: typeFor(site, page.ns),
      title: key,
      description,
      resource: pageUrl(site, page.title),
      tags: page.categories,
      timestamp: page.touched,
      revid: page.revid,
      namespace: page.ns,
      contenthash,
      body,
    };
    await writeConcept(bundleDir, doc);
    if (prev && prev.conceptId !== conceptId) {
      await removeConcept(bundleDir, prev.conceptId); // renamed upstream
    }
    logEntries.push({
      kind: prev ? "Update" : "Creation",
      line: `[${doc.title}](/${conceptId}.md)`,
    });
    state.pages[key] = {
      conceptId,
      revid: page.revid,
      contenthash,
      ns: page.ns,
      title: key,
      description,
    };
  }

  /** High-fidelity single-page render (correct PAGENAME context). */
  async function renderSingle(page: BulkPage): Promise<void> {
    try {
      const parsed = await parsePage(site, page.title);
      await processPage(page, parsed?.html ?? "");
    } catch (err) {
      console.warn(`[crawl] single render failed for "${page.title}": ${err}`);
    }
  }

  // --- Pass 2: batched render (default) with single-render fallbacks.
  const singles = singleMode
    ? toRender
    : toRender.filter((p) => needsSingleRender(p.wikitext));
  const batchable = singleMode
    ? []
    : toRender.filter((p) => !needsSingleRender(p.wikitext));

  let done = 0;
  const batches = chunk(batchable, BATCH_SIZE);
  await pool(batches, CONCURRENCY, async (batch) => {
    let htmls: string[];
    try {
      htmls = await renderBatch(
        site,
        batch.map((p) => ({ title: p.title, wikitext: p.wikitext })),
      );
    } catch (err) {
      console.warn(`[crawl] batch render failed (${batch.length} pages): ${err}`);
      htmls = batch.map(() => "");
    }
    for (let i = 0; i < batch.length; i++) {
      // A lost sentinel (empty html) OR a page whose title-context templates leaked
      // the batch title → re-render individually so PAGENAME resolves correctly.
      if (htmls[i] && !batchContextLeaked(htmls[i])) await processPage(batch[i], htmls[i]);
      else await renderSingle(batch[i]);
    }
    done += batch.length;
    console.log(`[crawl] rendered ${done}/${batchable.length}`);
  });

  if (singles.length) {
    console.log(`[crawl] single-render ${singles.length} PAGENAME-dependent pages`);
    await pool(singles, CONCURRENCY, renderSingle);
  }

  // --- Deletions: in manifest but no longer live upstream.
  // Skipped under --limit (enumeration intentionally incomplete) and under
  // --titles-file (a targeted re-render, not a full sync — must never delete).
  if (Number.isFinite(limit) || titleSet) { /* skip full-sync deletions */ }
  else for (const [key, ps] of Object.entries(state.pages)) {
    if (!liveTitles.has(key) && (onlyNs === undefined || ps.ns === onlyNs)) {
      await removeConcept(bundleDir, ps.conceptId);
      logEntries.push({
        kind: "Deprecation",
        line: `Seite „${ps.title}" wurde im Wiki entfernt (${ps.conceptId}.md).`,
      });
      delete state.pages[key];
    }
  }

  // --- Regenerate indexes + log, persist state.
  const titles = new Map<string, string>();
  const descriptions = new Map<string, string>();
  for (const ps of Object.values(state.pages)) {
    titles.set(ps.conceptId, ps.title);
    descriptions.set(ps.conceptId, ps.description);
  }
  await writeIndexes(bundleDir, descriptions, titles);
  await appendLog(bundleDir, logEntries);

  // Parse overworld raster maps (gifs) into routable grid artifacts. Guarded:
  // never let a map-parsing hiccup fail the whole crawl.
  try {
    await buildGridMaps(bundleDir, site);
  } catch (err) {
    console.warn(`[crawl] grid-map build failed: ${err}`);
  }

  state.lastRun = runStart;
  await saveState(bundleDir, state);

  console.log(
    `[crawl] done. ${logEntries.length} changes; ${Object.keys(state.pages).length} pages in bundle.`,
  );
}

main().catch((err) => {
  console.error("[crawl] failed:", err);
  process.exit(1);
});
