import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { httpGet, httpGetJson, httpPostFormJson, sleep } from "./http.js";
import { normalizeTitle } from "./okf.js";

/** A namespace as reported by the MediaWiki siteinfo API. */
export interface Namespace {
  id: number;
  name: string; // localized name, e.g. "Kategorie" ("" for the main namespace)
  canonical?: string;
}

export interface SiteInfo {
  apiBase: string; // resolved api.php endpoint
  server: string; // absolute server URL, e.g. http://unitopia.intelligense.de
  articlePath: string; // e.g. /wiki/$1
  namespaces: Map<number, Namespace>;
}

export interface PageRef {
  pageid: number;
  ns: number;
  title: string;
}

export interface ParsedPage {
  title: string;
  pageid: number;
  revid: number;
  html: string;
  categories: string[];
  touched: string; // ISO 8601
}

/** Candidate locations for api.php, tried in order during capability detection. */
const API_CANDIDATES = ["/wiki/api.php", "/api.php", "/w/api.php"];

/**
 * Probe the wiki for a working MediaWiki API endpoint and read siteinfo
 * (namespaces, server, article path). Throws if no api.php responds — the
 * caller may then fall back to HTML scraping.
 */
export async function discover(): Promise<SiteInfo> {
  const base = config.wikiBaseUrl.replace(/\/+$/, "");
  let lastErr: unknown;
  for (const path of API_CANDIDATES) {
    const apiBase = `${base}${path}`;
    const url = `${apiBase}?action=query&meta=siteinfo&siprop=general%7Cnamespaces&format=json`;
    try {
      const data = await httpGetJson<any>(url);
      if (!data?.query?.namespaces) continue;
      const namespaces = new Map<number, Namespace>();
      for (const ns of Object.values<any>(data.query.namespaces)) {
        namespaces.set(ns.id, {
          id: ns.id,
          name: ns["*"] ?? "",
          canonical: ns.canonical,
        });
      }
      const general = data.query.general ?? {};
      console.log(`[crawl] MediaWiki API found at ${apiBase}`);
      return {
        apiBase,
        server: general.server?.startsWith("http")
          ? general.server
          : base,
        articlePath: general.articlepath ?? "/wiki/$1",
        namespaces,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `No MediaWiki API endpoint reachable under ${base} (tried ${API_CANDIDATES.join(", ")}). Last error: ${String(lastErr)}`,
  );
}

/** Content namespaces worth archiving (skip Talk/User/MediaWiki internals). */
export function contentNamespaces(site: SiteInfo): number[] {
  // Main (0), Category (14), Help (12) and any other even, non-internal ns.
  const keep: number[] = [];
  for (const [id] of site.namespaces) {
    if (id < 0) continue; // Special/Media — not real pages
    if (id % 2 === 1) continue; // odd ids are Talk namespaces
    if ([2, 3, 8].includes(id)) continue; // User, User talk, MediaWiki
    keep.push(id);
  }
  return keep.sort((a, b) => a - b);
}

/** Enumerate every page in a namespace via list=allpages, following continues. */
export async function listAllPages(
  site: SiteInfo,
  ns: number,
  delayMs: number,
): Promise<PageRef[]> {
  const pages: PageRef[] = [];
  let apcontinue: string | undefined;
  do {
    const params = new URLSearchParams({
      action: "query",
      list: "allpages",
      apnamespace: String(ns),
      aplimit: "500",
      format: "json",
      maxlag: "5",
    });
    if (apcontinue) params.set("apcontinue", apcontinue);
    const data = await httpGetJson<any>(`${site.apiBase}?${params}`);
    for (const p of data?.query?.allpages ?? []) {
      pages.push({ pageid: p.pageid, ns, title: p.title });
    }
    apcontinue = data?.continue?.apcontinue;
    if (apcontinue) await sleep(delayMs);
  } while (apcontinue);
  return pages;
}

/**
 * Pages changed since `since` (ISO 8601), across content namespaces, via
 * list=recentchanges. Returns titles of new/edited pages and deleted titles.
 */
export async function recentChanges(
  site: SiteInfo,
  namespaces: number[],
  since: string,
  delayMs: number,
): Promise<{ changed: Set<string>; deleted: Set<string> }> {
  const changed = new Set<string>();
  const deleted = new Set<string>();
  let rccontinue: string | undefined;
  do {
    const params = new URLSearchParams({
      action: "query",
      list: "recentchanges",
      rcnamespace: namespaces.join("|"),
      rcprop: "title|loginfo",
      rctype: "edit|new|log",
      rcend: since,
      rclimit: "500",
      format: "json",
      maxlag: "5",
    });
    if (rccontinue) params.set("rccontinue", rccontinue);
    const data = await httpGetJson<any>(`${site.apiBase}?${params}`);
    for (const rc of data?.query?.recentchanges ?? []) {
      if (rc.type === "log" && rc.logaction === "delete") deleted.add(rc.title);
      else changed.add(rc.title);
    }
    rccontinue = data?.continue?.rccontinue;
    if (rccontinue) await sleep(delayMs);
  } while (rccontinue);
  // A page edited after deletion is not really gone.
  for (const t of changed) deleted.delete(t);
  return { changed, deleted };
}

/** Fetch rendered HTML, current revid, categories and touched time for a page. */
export async function parsePage(
  site: SiteInfo,
  title: string,
): Promise<ParsedPage | null> {
  const parseParams = new URLSearchParams({
    action: "parse",
    page: title,
    prop: "text|categories|revid",
    formatversion: "2",
    format: "json",
    maxlag: "5",
  });
  const parsed = await httpGetJson<any>(`${site.apiBase}?${parseParams}`);
  if (parsed?.error) return null;
  const p = parsed.parse;
  if (!p) return null;

  // Last-touched timestamp via prop=info.
  let touched = new Date().toISOString();
  try {
    const infoParams = new URLSearchParams({
      action: "query",
      prop: "info",
      titles: title,
      formatversion: "2",
      format: "json",
    });
    const info = await httpGetJson<any>(`${site.apiBase}?${infoParams}`);
    touched = info?.query?.pages?.[0]?.touched ?? touched;
  } catch {
    /* non-fatal */
  }

  return {
    title: p.title,
    pageid: p.pageid,
    revid: p.revid,
    html: p.text ?? "",
    categories: (p.categories ?? []).map((c: any) => c.category ?? c["*"] ?? ""),
    touched,
  };
}

/** Build the canonical browser URL for a wiki page. */
export function pageUrl(site: SiteInfo, title: string): string {
  return site.server + site.articlePath.replace("$1", title.replace(/ /g, "_"));
}

/** Quick reachability check used before falling back to HTML scraping. */
export async function isReachable(url: string): Promise<boolean> {
  try {
    const res = await httpGet(url);
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Bulk (fast) path: one cheap JSON pass for content + a batched render pass.
// ---------------------------------------------------------------------------

export interface BulkPage {
  pageid: number;
  ns: number;
  title: string;
  revid: number;
  touched: string; // ISO 8601
  wikitext: string;
  categories: string[]; // category names without the namespace prefix
}

/**
 * Fetch every page of a namespace in one cheap pass: wikitext + current revid +
 * last-touched + categories, 50 pages per request via generator=allpages. This
 * replaces ~2 requests/page (parse + info) with ~1 request/50 pages.
 */
export async function bulkFetchPages(
  site: SiteInfo,
  ns: number,
  delayMs: number,
  cap = Infinity,
): Promise<BulkPage[]> {
  const catPrefix = `${site.namespaces.get(14)?.name ?? "Category"}:`;
  const byId = new Map<number, BulkPage>();
  let cont: Record<string, string> | null = { continue: "" };
  do {
    const params = new URLSearchParams({
      action: "query",
      generator: "allpages",
      gapnamespace: String(ns),
      gaplimit: "50",
      prop: "revisions|info|categories",
      rvprop: "ids|timestamp|content",
      rvslots: "main",
      cllimit: "max",
      format: "json",
      formatversion: "2",
      maxlag: "5",
    });
    for (const [k, v] of Object.entries(cont!)) params.set(k, v);
    const data = await httpGetJson<any>(`${site.apiBase}?${params}`);
    for (const p of data?.query?.pages ?? []) {
      let bp = byId.get(p.pageid);
      if (!bp) {
        const rev = p.revisions?.[0];
        bp = {
          pageid: p.pageid,
          ns: p.ns,
          title: p.title,
          revid: rev?.revid ?? 0,
          touched: p.touched ?? new Date().toISOString(),
          wikitext: rev?.slots?.main?.content ?? "",
          categories: [],
        };
        byId.set(p.pageid, bp);
      }
      for (const c of p.categories ?? []) {
        const name = (c.title ?? "").startsWith(catPrefix)
          ? c.title.slice(catPrefix.length)
          : c.title ?? "";
        if (name) bp.categories.push(normalizeTitle(name));
      }
    }
    cont = data?.continue ?? null;
    if (byId.size >= cap) break; // test-only early stop (--limit)
    if (cont) await sleep(delayMs);
  } while (cont);
  return [...byId.values()];
}

/**
 * Render a batch of pages' wikitext in a SINGLE `action=parse&text=` call by
 * concatenating them with unique nonce sentinels, then splitting the rendered
 * HTML back into per-page fragments. Templates are fully expanded server-side.
 *
 * Returns an array aligned to `pages` (index i → HTML for pages[i]); an empty
 * string marks a page whose sentinel could not be located (caller should
 * fall back to a single-page render).
 *
 * Caveat: the parse runs under one fixed title context, so `{{PAGENAME}}`
 * resolves to that context for all pages — callers re-render PAGENAME-dependent
 * pages individually.
 */
export async function renderBatch(
  site: SiteInfo,
  pages: { title: string; wikitext: string }[],
): Promise<string[]> {
  if (pages.length === 0) return [];
  const nonce = randomBytes(6).toString("hex");
  const mark = (i: number) => `@@${nonce} ${i} ${nonce}@@`;
  const blob = pages
    .map((p, i) => `\n\n----\n\n${mark(i)}\n\n${p.wikitext}`)
    .join("");

  const form = new URLSearchParams({
    action: "parse",
    text: blob,
    contentmodel: "wikitext",
    title: "OKF-Sammelrendern",
    prop: "text",
    disablelimitreport: "1",
    disableeditsection: "1",
    format: "json",
    formatversion: "2",
  });
  const data = await httpPostFormJson<any>(site.apiBase, form);
  const html: string = data?.parse?.text ?? "";

  // Locate each sentinel and slice the HTML between consecutive markers.
  const re = new RegExp(`@@${nonce}\\s+(\\d+)\\s+${nonce}@@`, "g");
  const marks: { idx: number; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    marks.push({ idx: Number(m[1]), start: m.index, end: re.lastIndex });
  }

  const out = new Array<string>(pages.length).fill("");
  for (let j = 0; j < marks.length; j++) {
    const cur = marks[j];
    const sliceEnd = j + 1 < marks.length ? marks[j + 1].start : html.length;
    if (cur.idx >= 0 && cur.idx < pages.length) {
      out[cur.idx] = html.slice(cur.end, sliceEnd);
    }
  }
  return out;
}
