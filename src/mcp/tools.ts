import type { Document } from "@langchain/core/documents";
import type { Backends } from "../backends.js";
import { config } from "../config.js";
import { readPageBody } from "../catalog.js";
import { formatRoute } from "../nav/mapGraph.js";

/**
 * Pure MCP tool handlers over the shared backends. No chat-LLM calls live here
 * (only embeddings, via the vector store, which retrieval needs anyway); on any
 * ambiguity the handler returns candidates for the calling model to disambiguate
 * with a follow-up call. Output is kept token-lean: `search` returns snippets,
 * not full bodies — `fetch` pulls a full page only when the model asks for it.
 */

const SNIPPET_CHARS = 180;

/** Down-rank the buyable "Karte/<Ort>" paper-map item stubs below real pages —
 *  mirrors the graph's `sink` at graph.ts:484-485. */
const isKarteItem = (d: Document) => /^Karte\//.test(d.metadata?.title ?? "");
const sink = (arr: Document[]) => [
  ...arr.filter((d) => !isKarteItem(d)),
  ...arr.filter(isKarteItem),
];

export interface SearchHit {
  id: string;
  title: string;
  snippet: string;
}

/** Tier 1: cheap ranked hits (id + title + short snippet). The model then calls
 *  `fetch` on the ids it wants in full. */
export async function search(
  b: Backends,
  args: { query: string; k?: number },
): Promise<{ hits: SearchHit[] }> {
  const k = args.k ?? config.topK;
  // Same domain-synonym nudge the pipeline uses (graph.ts:468-469).
  let q = args.query.slice(0, config.maxQueryChars);
  if (/hafen/i.test(q)) q += " Kurstafel Hafengebiet Steg";

  const ranked = await b.hybrid.search(q, k);

  const hits = sink(ranked).map((d) => {
    const id = d.metadata?.conceptId ?? "";
    const title =
      d.metadata?.title ?? b.catalog?.getByConceptId(id)?.title ?? "Eintrag";
    const body: string = d.pageContent ?? "";
    return {
      id,
      title,
      snippet: body.length > SNIPPET_CHARS ? body.slice(0, SNIPPET_CHARS) + "…" : body,
    };
  });
  return { hits };
}

export interface FetchResult {
  id: string;
  title: string;
  body: string;
  neighbors: { id: string; title: string }[];
  variants: { id: string; title: string }[];
}

/** Tier 2: the full page body for one id, plus its 1-hop neighbours and
 *  subpage variants as {id,title} (not bodies) so the model can pull more only
 *  if it needs to. */
export async function fetch(
  b: Backends,
  args: { id: string; maxChars?: number },
): Promise<FetchResult> {
  const body = await readPageBody(args.id, args.maxChars ?? 4000);
  const entry = b.catalog?.getByConceptId(args.id);
  const map = (e: { conceptId: string; title: string }) => ({ id: e.conceptId, title: e.title });
  return {
    id: args.id,
    title: entry?.title ?? args.id,
    body,
    neighbors: entry && b.catalog ? b.catalog.neighbors(entry).map(map) : [],
    variants: entry && b.catalog ? b.catalog.variantsOf(entry).map(map) : [],
  };
}

export interface CategoryResult {
  categories: { name: string; count: number; members: { id: string; title: string }[] }[];
  candidates?: string[];
}

/** Resolve "list all X": deterministic name/alias match first, then a semantic
 *  fallback. Returns members as {id,title}; when nothing is confident, returns
 *  candidate category names for the model to retry. */
export async function listCategory(
  b: Backends,
  args: { query: string },
): Promise<CategoryResult> {
  if (!b.catalog) return { categories: [], candidates: [] };
  const cat = b.catalog;
  const toMembers = (ids: string[]) =>
    ids
      .map((id) => {
        const e = cat.getByConceptId(id);
        return e ? { id, title: e.title } : null;
      })
      .filter((x): x is { id: string; title: string } => x !== null);

  const hits = cat.resolveCategoriesInQuery(args.query);
  if (hits.length >= 1) {
    return {
      categories: hits.map((h) => ({ name: h.name, count: h.members.length, members: toMembers(h.members) })),
    };
  }

  // Semantic fallback — needs the query embedded by the dense backend. Only
  // available in an embedding mode (hybrid); BM25-only mode relies on the
  // deterministic alias/compound matching above (and the client LLM to rephrase).
  if (b.store && cat.semanticReady) {
    const qv = await b.store.embeddings.embedQuery(args.query);
    const near = cat.nearestCategories(qv, 1, 0.66);
    if (near.length) {
      return {
        categories: near.map((h) => ({ name: h.name, count: h.members.length, members: toMembers(h.members) })),
      };
    }
    // Nothing confident: offer looser matches as candidates to retry.
    const loose = cat.nearestCategories(qv, 5, 0.4).map((h) => h.name);
    return { categories: [], candidates: loose };
  }
  return { categories: [], candidates: [] };
}

export interface RouteToolResult {
  ok: boolean;
  from?: string;
  to?: string;
  steps?: string[];
  command?: string | null;
  ascii?: string;
  text?: string;
  ambiguous?: boolean;
  candidates?: { hint: string | null; pages: { page: string; rooms: string[] }[] };
  /** Advice for the model on how to recover from a failed/ambiguous call. */
  guidance?: string;
  error?: string;
}

/** Deterministic room-to-room routing. Without `page`, auto-resolves the
 *  endpoints and routes ACROSS maps when needed (city → overworld → area). With
 *  `page`, routes strictly within that one map (use only to disambiguate two
 *  rooms on the same map). On failure, returns candidate pages + guidance. */
export async function route(
  b: Backends,
  args: { from: string; to: string; page?: string },
): Promise<RouteToolResult> {
  if (!b.nav) return { ok: false, error: "routing disabled (no navrooms.json)" };

  const r = args.page
    ? await b.nav.routeByNames(args.page, args.from, args.to)
    : await b.nav.resolveAndRoute(args.from, args.to);

  if (r.ok) {
    const steps = (r.steps ?? []).map((s) => {
      // Marcopolo-sourced steps (fallback graph) are flagged so the user knows the
      // move comes from the older secondary maps, and carry a traversal hint.
      const tag = s.source === "marcopolo" ? " «lt. marcopolo-Karte»" : "";
      const hint = s.hint ? ` (${s.hint})` : "";
      if (s.transition) return `[${s.transition}]${tag}`;
      if (!s.hidden) return `${s.dir}${hint}${tag}`;
      // A HIDDEN move: a '/dotted path carries NO direction — its compass label is
      // pure geometry and misleading — so never show it. Only a ˄/˅ move conveys a
      // real hoch/runter. Prefer the marcopolo clarification when present.
      const vertical = s.dir === "hoch" || s.dir === "runter";
      if (s.hint) return vertical ? `${s.dir} – ${s.hint}${tag}` : `${s.hint}${tag}`;
      if (s.dir === "hoch") return "hoch (Befehl unklar – evtl. »klettere hoch«, tüfteln)";
      if (s.dir === "runter") return "runter (Befehl unklar – tüfteln)";
      return "??? (unklarer Weg – Richtung nicht ablesbar, tüfteln)";
    });
    return {
      ok: true,
      from: r.from,
      to: r.to,
      steps,
      command: r.clear ? `tue ${(r.steps ?? []).map((s) => s.dir).join(" ")}` : null,
      ascii: r.ascii,
      text: formatRoute(r),
    };
  }

  // Not resolved deterministically → hand back candidates + recovery guidance.
  const candidates = b.nav.routeCandidates(args.from, args.to);
  const guidance = args.page
    ? `Routing was restricted to the single map '${args.page}', where one of the rooms does not exist — it is likely on a different map. Re-call WITHOUT 'page' (the router stitches cross-map/area trips itself), adding the area to each room name if known (e.g. '${args.from} in <Area>').`
    : "No single map holds both rooms under these names. Re-call WITHOUT 'page', making each room name more specific by adding its area (e.g. 'Marktplatz in Foo-Ling-Yoo', 'Nurikomoon-Tempel in Asia'). Only set 'page' if BOTH rooms are listed together on one candidate page below.";
  return { ok: false, ambiguous: true, candidates, guidance, error: r.error };
}

export interface MapToolResult {
  area?: string;
  block?: string;
  candidates?: { page: string; maps: { anchor: string; rooms: string[] }[] }[];
}

/** Render an ASCII sub-map. With `page` (+ `anchor`) render that named sub-map;
 *  otherwise gather candidate pages/sub-maps for the model to pick from. */
export async function map(
  b: Backends,
  args: { area: string; page?: string; anchor?: string },
): Promise<MapToolResult> {
  if (!b.nav) return { candidates: [] };
  if (args.page) {
    const rendered = await b.nav.renderNamedMap(args.page, args.anchor ?? args.area);
    if (rendered) return { area: rendered.area, block: rendered.block };
  }
  const candidates = await b.nav.mapCandidates(args.area);
  return { candidates };
}
