import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { listRooms, routeOnPage, pageMaps, pageLinks, deumlaut, roomTokens, tokenOverlap, type PageMap, type RouteResult, type RouteStep } from "./mapGraph.js";
import { routeOnGrid, renderGridAscii } from "./grid/gridRouter.js";
import type { GridMap } from "./grid/types.js";
import { routeUnified } from "./graph/router.js";
import type { UnifiedGraph } from "./graph/types.js";

/**
 * Builds and serves a room→page index so a "wie komme ich von X nach Y" query
 * can find the area page whose maps contain both rooms, then route on it.
 */
const RESERVED = new Set(["index.md", "log.md"]);
const NAV_FILE = "navrooms.json";
const navPath = () => path.join(config.indexDir, NAV_FILE);

interface NavRooms { rooms: { page: string; name: string }[]; gridMaps?: GridMap[] }

/** Load parsed overworld grid-map artifacts from `_gridmaps/*.json`. Shipped in
 *  the KB tarball; skipped by the ASCII scanners (they ignore `_`-dirs). */
async function loadGridMaps(root: string): Promise<GridMap[]> {
  const dir = path.join(root, config.gridMapsSubdir);
  if (!existsSync(dir)) return [];
  const out: GridMap[] = [];
  for (const e of await readdir(dir)) {
    if (!e.endsWith(".json")) continue;
    try { out.push(JSON.parse(await readFile(path.join(dir, e), "utf8")) as GridMap); }
    catch { /* skip a malformed artifact */ }
  }
  return out;
}

async function collectMd(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (e.name.startsWith("_")) continue; out.push(...(await collectMd(path.join(dir, e.name)))); }
    else if (e.name.endsWith(".md") && !RESERVED.has(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

/** Scan the bundle for pages with ASCII maps and record their rooms. */
async function computeNavRooms(): Promise<NavRooms> {
  const root = path.resolve(config.kbDir);
  const files = await collectMd(root);
  const rooms: { page: string; name: string }[] = [];
  for (const file of files) {
    const md = await readFile(file, "utf8");
    if (!/[o~]--|--[o~]|\n\s*[o~]\s/.test(md)) continue; // cheap pre-filter for maps
    const conceptId = path.relative(root, file).replace(/\.md$/, "").split(path.sep).join("/");
    for (const r of listRooms(md)) rooms.push({ page: conceptId, name: r.name });
  }
  // Overworld grid maps: each region + its gateway tiles become routable rooms.
  const gridMaps = await loadGridMaps(root);
  for (const g of gridMaps) {
    rooms.push({ page: g.page, name: g.region });
    for (const gw of g.gateways) {
      // A gateway is findable by its label (the room name) AND, when it carries a
      // distinct anchor (same-image points of interest like "Weltenrand"/"Handelsfort"
      // whose anchor is the name users actually search), by that anchor too.
      rooms.push({ page: g.page, name: gw.label });
      if (gw.anchor && gw.anchor !== gw.label) rooms.push({ page: g.page, name: gw.anchor });
    }
  }
  return { rooms, gridMaps };
}

/** Build the nav index and persist it as `navrooms.json` next to the index. */
export async function buildNavIndex(): Promise<void> {
  const data = await computeNavRooms();
  await writeFile(navPath(), JSON.stringify(data));
  console.log(`[nav] ${data.rooms.length} map rooms across pages → ${navPath()}`);
}

/** Build the in-memory nav index directly from the KB (no navrooms.json). */
export async function buildNavInMemory(): Promise<NavIndex> {
  return new NavIndex(await computeNavRooms());
}

export interface RouteCandidates {
  hint: string | null;
  pages: { page: string; rooms: string[] }[];
}

/** A directed edge in the cross-page graph: leave `exit` on the current page,
 *  arrive at `entry` on page `to`. */
interface PageEdge { to: string; exit: string; entry: string; }

export class NavIndex {
  private rooms: { page: string; name: string }[];
  private roomsByPage = new Map<string, string[]>();
  private gridByPage = new Map<string, GridMap>();
  constructor(data: NavRooms) {
    this.rooms = data.rooms;
    for (const r of data.rooms) {
      const a = this.roomsByPage.get(r.page);
      if (a) a.push(r.name);
      else this.roomsByPage.set(r.page, [r.name]);
    }
    for (const g of data.gridMaps ?? []) this.gridByPage.set(g.page, g);
  }
  get size() { return this.rooms.length; }

  // Merged per-region graphs (wiki + marcopolo), loaded lazily from _navgraph/.
  private regionGraphs?: UnifiedGraph[];
  private async ensureRegionGraphs(): Promise<UnifiedGraph[]> {
    if (this.regionGraphs) return this.regionGraphs;
    this.regionGraphs = [];
    const dir = path.join(path.resolve(config.kbDir), "_navgraph");
    if (existsSync(dir)) {
      for (const e of await readdir(dir)) {
        if (!e.endsWith(".json")) continue;
        try { this.regionGraphs.push(JSON.parse(await readFile(path.join(dir, e), "utf8")) as UnifiedGraph); }
        catch { /* skip a malformed artifact */ }
      }
    }
    return this.regionGraphs;
  }

  // Per-page climb hints: wiki node gid → a marcopolo clarification for a HIDDEN
  // exit (e.g. wiki "14 Lawinengefahr"'s unclear `'` move is a "kletter runter").
  // Derived from the merged graph: a wiki node bound to marcopolo whose marcopolo
  // out-edges are climbs. Used to ANNOTATE (never re-route) the primary wiki route.
  private climbHints?: Map<string, Map<string, string>>;
  private async ensureClimbHints(): Promise<Map<string, Map<string, string>>> {
    if (this.climbHints) return this.climbHints;
    const result = new Map<string, Map<string, string>>();
    for (const g of await this.ensureRegionGraphs()) {
      const byId = new Map(g.nodes.map((n) => [n.id, n]));
      const out = new Map<string, typeof g.edges>();
      for (const e of g.edges) { const a = out.get(e.from); if (a) a.push(e); else out.set(e.from, [e]); }
      for (const n of g.nodes) {
        if (!n.id.startsWith("wiki:") || !n.sources.some((s) => s.origin === "marcopolo")) continue;
        const climbs = (out.get(n.id) ?? []).filter((e) => e.origin === "marcopolo" && (e.command === "hoch" || e.command === "runter" || /klett/i.test(e.hint ?? "")));
        if (!climbs.length) continue;
        const m = /^wiki:(.+?)#(.+)$/.exec(n.id);
        if (!m) continue;
        const [, page, gid] = m;
        const downE = climbs.filter((e) => e.command === "runter" || /runter|hinab/i.test(e.hint ?? ""));
        const upE = climbs.filter((e) => e.command === "hoch" || /hoch|hinauf/i.test(e.hint ?? ""));
        const verb = downE.length && !upE.length ? "runter" : upE.length && !downE.length ? "hoch" : "hoch/runter";
        const relevant = verb === "runter" ? downE : verb === "hoch" ? upE : climbs; // name only the matching-direction targets
        const dests = [...new Set(relevant.map((e) => byId.get(e.to)?.name).filter(Boolean))].slice(0, 2).join(" / ");
        const hint = `laut marcopolo-Karte: hier klettert man ${verb}${dests ? ` (Richtung ${dests})` : ""}`;
        (result.get(page) ?? result.set(page, new Map()).get(page)!).set(gid, hint);
      }
    }
    this.climbHints = result;
    return result;
  }

  /** LAST-resort routing over the merged region graphs (wiki + marcopolo
   *  fallback edges). Only reached after the authoritative wiki routers fail, so
   *  it can complete a gap-blocked trip but never override a working route. */
  private async routeViaRegionGraph(fromQ: string, toQ: string): Promise<RouteResult | null> {
    for (const g of await this.ensureRegionGraphs()) {
      const r = routeUnified(g, fromQ, toQ);
      if (r.ok && (r.steps ?? []).some((s) => s.source === "marcopolo")) return r;
    }
    return null;
  }

  private pagesFor(q: string): Set<string> {
    const ql = deumlaut(q);
    const out = new Set<string>();
    for (const r of this.rooms) if (deumlaut(r.name).includes(ql)) out.add(r.page);
    return out;
  }

  /** Candidate forms of an endpoint: the raw query, then with a trailing
   *  location qualifier stripped, plus that location as a page hint. Two shapes:
   *  - explicit connector: "Marktplatz in/von/bei Foo-Ling-Yoo"
   *  - bare apposition:    "Marktplatz Foo-Ling-Yoo" — where the trailing run of
   *    words is itself a known map page. Without this, a precise area tacked
   *    straight onto a generic room name ("Marktplatz") would match nothing and
   *    the endpoint would resolve to no page at all. */
  private candidates(q: string): { forms: string[]; hint: string | null } {
    const forms = [q.trim()];
    let hint: string | null = null;
    const m = /^(.*\S)\s+(?:in|im|von|vom|bei|auf|am|an)\s+(\S[\w äöüÄÖÜß-]*)$/i.exec(q.trim());
    // Canonicalise the hint to a page slug (hyphen-joined) so it compares against
    // page ids regardless of how the user spaced/hyphenated the area name — "foo
    // ling yoo", "Foo-Ling-Yoo" and "foo ling yoo" all pin the `foo-ling-yoo` page.
    if (m) { forms.push(m[1].trim()); hint = deumlaut(m[2]).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || null; }
    else {
      const words = q.trim().split(/\s+/);
      for (let i = 1; i < words.length; i++) {
        const slug = this.mapPageSlug(words.slice(i).join(" "));
        if (slug) { forms.push(words.slice(0, i).join(" ")); hint = slug; break; }
      }
    }
    return { forms, hint };
  }

  /**
   * Gather candidate area pages + their room lists for a route question, using
   * loose token overlap so the LLM (not brittle string code) can pick the exact
   * start/destination rooms it understands the user to mean. Prefers pages that
   * plausibly contain BOTH endpoints, and a page matching the location hint.
   */
  routeCandidates(fromQ: string, toQ: string): RouteCandidates {
    const fc = this.candidates(fromQ), tc = this.candidates(toQ);
    const hint = tc.hint ?? fc.hint;
    const fTok = roomTokens(fc.forms[fc.forms.length - 1]);
    const tTok = roomTokens(tc.forms[tc.forms.length - 1]);
    const pagesWith = (tok: string[]) => {
      const s = new Set<string>();
      for (const r of this.rooms) if (tokenOverlap(tok, r.name)) s.add(r.page);
      return s;
    };
    const fLoose = pagesWith(fTok), tLoose = pagesWith(tTok);
    // Tight (word-boundary) matches are far more trustworthy than loose token
    // overlap ("bank" ⊂ "landesbank" matches every bank in the world). Rank by
    // tight matches first so the genuinely correct page surfaces, with loose
    // overlap only as filler and the location hint as a soft tie-breaker.
    const fTight = new Set(this.matchesByPage(fromQ).keys());
    const tTight = new Set(this.matchesByPage(toQ).keys());
    const score = (p: string) =>
      (fTight.has(p) ? 4 : 0) + (tTight.has(p) ? 4 : 0) +
      (fLoose.has(p) ? 1 : 0) + (tLoose.has(p) ? 1 : 0) +
      (hint && deumlaut(p).includes(hint) ? 1 : 0);
    const all = [...new Set([...fTight, ...tTight, ...fLoose, ...tLoose])];
    const pages = all.filter((p) => score(p) > 0).sort((a, b) => score(b) - score(a));
    return {
      hint,
      pages: pages.slice(0, 5).map((p) => ({ page: p, rooms: (this.roomsByPage.get(p) ?? []).slice(0, 200) })),
    };
  }

  /** Pages where this endpoint matches rooms, split into exact vs. substring
   *  matches per page. Defaults to the raw + qualifier-stripped query forms;
   *  pass `formsOverride` to match against a specific form set (e.g. the verbatim
   *  query only). */
  private matchesByPage(q: string, formsOverride?: string[]): Map<string, { exact: Set<string>; sub: Set<string> }> {
    const forms = formsOverride ?? this.candidates(q).forms;
    // Separator-insensitive, word-boundary normalization: "Alt-Ware" matches
    // "Recycling-Büro (Alt Ware)", but "Tor" does NOT match inside "Brückentor".
    const norm = (s: string) => ` ${deumlaut(s).replace(/[^a-z0-9]+/g, " ").trim()} `;
    const out = new Map<string, { exact: Set<string>; sub: Set<string> }>();
    for (const r of this.rooms) {
      const rn = norm(r.name);
      for (const f of forms) {
        const fq = norm(f);
        if (fq.trim() === "") continue;
        const exact = rn === fq;
        const sub = rn.includes(fq); // query is a contiguous word-run of the room name
        if (!exact && !sub) continue;
        let e = out.get(r.page);
        if (!e) { e = { exact: new Set(), sub: new Set() }; out.set(r.page, e); }
        if (exact) e.exact.add(r.name);
        if (sub) e.sub.add(r.name);
      }
    }
    return out;
  }

  /**
   * The pages an endpoint most credibly refers to — the key to not drifting to a
   * coincidentally-named room in the wrong area. Tiers, strongest first:
   *  1. The verbatim query (its real, un-stripped name): "Hafen von Westgallien"
   *     is a specific gateway on ONE map; don't let it decay into a generic
   *     "Hafen" that matches every harbour in the world.
   *  2. Else the qualifier-stripped forms, but pinned by a location hint when the
   *     query carried one: "Marktplatz in Foo-Ling-Yoo" → only Foo-Ling-Yoo's
   *     pages, not every page that happens to have a "Marktplatz".
   *  3. Else the loose stripped-form matches (best effort).
   */
  private endpointPages(q: string): Map<string, { exact: Set<string>; sub: Set<string> }> {
    const { forms, hint } = this.candidates(q);
    const full = this.matchesByPage(q, forms.slice(0, 1));
    if (full.size) return full;
    const all = this.matchesByPage(q);
    if (hint) {
      const pinned = new Map([...all].filter(([p]) => deumlaut(p).includes(hint)));
      if (pinned.size) return pinned;
    }
    return all;
  }

  /** Resolve one endpoint to a single room on a page, using the strongest
   *  available signal. Returns null when it can't decide (→ defer to the LLM).
   *  A verbatim exact match wins; for several substring matches, an area
   *  destination prefers a gateway room ("…tor…", e.g. "Osttor von Borsippa")
   *  over a street merely named after the area ("Borsippa-Straße"). */
  private roomFor(m: { exact: Set<string>; sub: Set<string> }): string | null {
    // Several legend rows can describe the SAME physical place, differing only in
    // their parenthetical (e.g. "Westtor (Stadtwache & Handelsweg Borsippa)" and
    // "Westtor (Handelsweg Borsippa)" are both the one West gate). Collapse such
    // rows by their base name (text before the first "(") so they count as one.
    const base = (n: string) => deumlaut(n).split("(")[0].replace(/[^a-z0-9 ]/g, " ").trim();
    const sameBase = (set: Set<string>) => new Set([...set].map(base)).size === 1;
    if (m.exact.size === 1) return [...m.exact][0];
    if (m.exact.size > 1) return sameBase(m.exact) ? [...m.exact][0] : null;
    if (m.sub.size === 1) return [...m.sub][0];
    if (m.sub.size > 1) {
      const gates = [...m.sub].filter((n) => /tor(\b|\s|$)/i.test(deumlaut(n)));
      if (gates.length === 1) return gates[0];
      // Multiple gate rows that are the same gate under different legends → one.
      if (gates.length > 1 && sameBase(new Set(gates))) return gates[0];
    }
    return null;
  }

  /**
   * Deterministic endpoint resolution + route. Picks the shared page where both
   * endpoints match most strongly (a verbatim exact match counts more than a
   * substring one), resolves each to a single room, and routes. Returns
   * `{ ambiguous: true }` when it genuinely can't decide — the caller then hands
   * the choice to the LLM rather than letting substring matching pick blindly.
   */
  /** Overworld-gateway interpretations of an endpoint: the gridmap tiles that ARE
   *  this location (a harbour, a city entrance, a region marker). Strict match — an
   *  exact token-set on the gateway label, the whole query being the target-page
   *  slug, or an "Eingang «City»" phrasing → the tile whose target is that city — so
   *  an interior room name never masquerades as a gateway (which keeps ordinary
   *  cross-page routes untouched). "Eingang" is semantics for the gateway node. */
  private gridGatewayOf(q: string): { page: string; col: number; row: number; label: string }[] {
    const norm = (s: string) => deumlaut(s).replace(/[^a-z0-9]+/g, "");
    const toks = (s: string) => new Set(roomTokens(s));
    const setEq = (a: Set<string>, b: Set<string>) => a.size > 0 && a.size === b.size && [...a].every((x) => b.has(x));
    const qTok = toks(q), qNorm = norm(q);
    const eingangCity = /\beingang\b/i.test(deumlaut(q)) ? norm(deumlaut(q).replace(/\beingang\b/gi, "")) : null;
    const out: { page: string; col: number; row: number; label: string }[] = [];
    const seen = new Set<string>();
    for (const [page, g] of this.gridByPage) for (const gw of g.gateways) {
      const tgt = gw.target ? norm(gw.target.split("/").pop()!) : "";
      // The city-proper entrance tile — not a sub-area gateway like a harbour, which
      // targets the same city but via a #anchor (target "dörrstadt#Hafen").
      const cityProper = !gw.anchor || setEq(toks(gw.label), toks(gw.target?.split("/").pop() ?? ""));
      const match =
        setEq(qTok, toks(gw.label)) ||                                        // exact label ("Hafen Dörrstadt")
        (cityProper && !!tgt && tgt === (eingangCity ?? qNorm));              // "Eingang «City»" / bare city → its entrance
      if (!match) continue;
      const key = `${page}:${gw.col},${gw.row}`;
      if (!seen.has(key)) { seen.add(key); out.push({ page, col: gw.col, row: gw.row, label: gw.label }); }
    }
    return out;
  }

  async resolveAndRoute(fromQ: string, toQ: string): Promise<RouteResult & { ambiguous?: boolean }> {
    // Overworld is authoritative: when BOTH endpoints are gateway tiles on a common
    // gridmap (a harbour, a city entrance, a region marker), the journey between them
    // is the real overland walk across the tiles — NOT a free in-page anchor teleport
    // (e.g. Hafen von Dörrstadt → Eingang Dörrstadt is ~13 südwest/west steps on the
    // Dörrland overworld, not one shortcut). Interior rooms don't match a gateway, so
    // ordinary cross-page routes are unaffected.
    const fg = this.gridGatewayOf(fromQ), tg = this.gridGatewayOf(toQ);
    for (const a of fg) for (const b of tg) {
      if (a.page !== b.page || (a.col === b.col && a.row === b.row)) continue;
      const r = await this.routeByNames(a.page, `${a.col},${a.row}`, `${b.col},${b.row}`);
      if (r.ok) return { ...r, from: a.label, to: b.label };
    }
    const fc = this.candidates(fromQ), tc = this.candidates(toQ);
    const hint = tc.hint ?? fc.hint;
    const fm = this.endpointPages(fromQ), tm = this.endpointPages(toQ);
    const shared = [...fm.keys()].filter((p) => tm.has(p));
    // No single page holds both endpoints → the trip spans several maps.
    if (!shared.length) {
      const cross = await this.routeCrossPage(fromQ, toQ);
      if (cross.ok) return cross;
      return (await this.routeViaRegionGraph(fromQ, toQ)) ?? cross;
    }
    // Is an endpoint its OWN area (a map page, e.g. "Borsippa")? Then it's a
    // cross-area trip and the location hint — usually the START's region — must
    // not pin us to the wrong page. For a within-area destination ("Hafen" in
    // Tadmor, no "hafen" map page) the hint is exactly what disambiguates which
    // city's Hafen is meant, so weight it heavily.
    const crossArea = this.hasMapPage(toQ) || this.hasMapPage(fromQ);
    const side = (x: { exact: Set<string> }) => (x.exact.size ? 4 : 2);
    const score = (p: string) =>
      side(fm.get(p)!) + side(tm.get(p)!) + (!crossArea && hint && deumlaut(p).includes(hint) ? 6 : 0);
    const scored = [...shared].sort((a, b) => score(b) - score(a));
    // "Hafen" as a destination means the harbour proper — its Kurstafel (the
    // ship-course board, the canonical landing spot), which lives on the harbour
    // sub-map — NOT merely the city gate "Richtung Hafen" that roomFor would pick.
    // So when the harbour is the goal, route all the way to the Kurstafel first.
    const hafenDest = /\bhafen\b/i.test(deumlaut(toQ));
    let tried = false;
    for (const p of scored) {
      if (hafenDest) {
        const rk = await this.routeByForms(p, fc.forms, ["Kurstafel"]);
        if (rk.ok) { tried = true; return rk; }
      }
      const from = this.roomFor(fm.get(p)!), to = this.roomFor(tm.get(p)!);
      if (from && to) {
        tried = true;
        const r = await this.routeByNames(p, from, to);
        if (r.ok) return r;
      }
      // A room was ambiguous on this page — let findNode resolve it within this
      // SINGLE page via the query forms (substring within one page is safe).
      // Fall back to the Kurstafel landmark, then the generic harbour rooms.
      const toForms = hafenDest ? ["Kurstafel", ...tc.forms] : tc.forms;
      const r = await this.routeByForms(p, fc.forms, toForms);
      if (r.ok) { tried = true; return r; }
    }
    // Endpoints share a page by name but no path connects them there (e.g. two
    // rooms that merely happen to co-occur) — try stitching across maps instead.
    const cross = await this.routeCrossPage(fromQ, toQ);
    if (cross.ok) return cross;
    const viaGraph = await this.routeViaRegionGraph(fromQ, toQ);
    if (viaGraph) return viaGraph;
    return { ok: false, ambiguous: !tried || scored.length > 0 };
  }

  // --- Cross-page routing (paths that span several ASCII maps) --------------
  // A directed page edge: leave `from` via room `exit`, arrive on `to` at room
  // `entry`. Built from RECIPROCAL legend links between two map pages (A has a
  // gateway room linking to B and B has one linking back to A). One-directional
  // links — often connections that only exist on the big image maps — are
  // skipped, per the "ignore image-only links for now" requirement.
  private pageEdges?: Map<string, PageEdge[]>;

  private async ensurePageGraph(): Promise<void> {
    if (this.pageEdges) return;
    const root = path.resolve(config.kbDir);
    const isMapPage = (p: string) => this.roomsByPage.has(p);
    // Gateway rooms per page, filtered to targets that are themselves map pages.
    const linksByPage = new Map<string, { name: string; targets: string[] }[]>();
    for (const page of this.roomsByPage.keys()) {
      const file = path.join(root, `${page}.md`);
      if (!existsSync(file)) continue;
      const gws = pageLinks(await readFile(file, "utf8"))
        .map((g) => ({ name: g.name, targets: g.targets.filter(isMapPage) }))
        .filter((g) => g.targets.length);
      if (gws.length) linksByPage.set(page, gws);
    }
    const edges = new Map<string, PageEdge[]>();
    const add = (from: string, e: PageEdge) => {
      const a = edges.get(from) ?? [];
      if (!a.some((x) => x.to === e.to && x.exit === e.exit && x.entry === e.entry)) a.push(e);
      edges.set(from, a);
    };
    for (const [page, gws] of linksByPage) {
      for (const g of gws) {
        // A gateway lists its links as [immediate neighbour, …distal destinations]:
        // e.g. Tadmor's Westtor → [handelsweg-borsippa, borsippa], where the road
        // is the neighbour and the city is where the road leads. Only the FIRST
        // target is a real adjacency; using the rest would build a teleport edge
        // that skips the road maps the user wants traversed.
        const tgt = g.targets[0];
        if (tgt === page) continue;
        const back = (linksByPage.get(tgt) ?? []).filter((bg) => bg.targets[0] === page || bg.targets.includes(page));
        if (!back.length) continue; // no reciprocal ASCII link → skip
        // Entry room on `tgt` = the reciprocal gateway whose name best matches
        // the exit room's (Westtor ↔ "Westtor von Tadmor"); else the first.
        const gTok = roomTokens(g.name);
        const entry = [...back].sort((a, b) => Number(tokenOverlap(gTok, b.name)) - Number(tokenOverlap(gTok, a.name)))[0];
        add(page, { to: tgt, exit: g.name, entry: entry.name });
      }
    }
    // Overworld grid gateways ARE the authoritative link between a raster map and
    // a city/ASCII page (the imagemap rect), so wire them both ways directly —
    // the city rarely links back in ASCII (it links to the gif, not an "asia"
    // page). Entry room on the city = its room that best matches the gateway.
    // The region's own ASCII page (e.g. grid `karte/märchenland` ↔ page
    // `märchenland`): some overworld tiles OVERLAP a room drawn on one of that
    // page's ASCII sub-maps — the tile and the room are the same place (a
    // "Wolke vom Sandmännchen" tile is the Gebirge sub-map's "Auf einer Wolke
    // (Sandmännchen)" room). The fine-grained destination lives only on the
    // ASCII sub-map, so a name-matched seam here lets a route step off the
    // overworld straight onto the exact room, not a generic city entrance.
    const lastSeg = (p: string) => p.split("/").pop()!;
    for (const grid of this.gridByPage.values()) {
      const regionSlug = lastSeg(grid.page);
      const regionPage = [...this.roomsByPage.keys()].find(
        (p) => p !== grid.page && !this.gridByPage.has(p) && lastSeg(p) === regionSlug,
      );
      // Sub-maps of the region page, to resolve the ground room a tile overlaps.
      const regionFile = regionPage ? path.join(root, `${regionPage}.md`) : null;
      const regionMaps = regionFile && existsSync(regionFile) ? pageMaps(await readFile(regionFile, "utf8")) : [];
      for (const gw of grid.gateways) {
        const tgt = gw.target;
        if (tgt && tgt !== grid.page && isMapPage(tgt) && !this.gridByPage.has(tgt)) {
          // The city's gate is structural, not lexical: the one room whose legend
          // link points BACK to the overworld region (e.g. Koboldingen's lettered
          // "S Stadttore → märchenland"). Prefer it; only if the page has no such
          // back-link fall back to the name/keyword guess.
          const gate = (linksByPage.get(tgt) ?? []).find((l) => l.targets.includes(regionSlug))?.name;
          const cityRoom = gate ?? this.bestRoomOn(tgt, gw.anchor ?? gw.label) ?? gw.label;
          add(grid.page, { to: tgt, exit: gw.label, entry: cityRoom }); // enter the city
          add(tgt, { to: grid.page, exit: cityRoom, entry: gw.label }); // step back onto the overworld
        }
        // Overlap seam onto the region's own ASCII sub-maps. Name-matching finds
        // the FEATURE the tile marks (the Gebirge's "Auf einer Wolke"). Usually
        // you step off the overworld straight onto it. The exception is an
        // ELEVATED feature: there you land on the ground room that overlaps the
        // worldmap (the "#Karte"-linked "Pfad im Gebirge") and the ASCII map does
        // the last hop ("hoch" onto the cloud). Take that redirect ONLY when the
        // ground room genuinely connects to the feature — in Asia the "Pfad auf
        // Asia" does NOT reach the Nurikomoon-Tempel, so land on the temple.
        if (regionPage) {
          const feature = this.bestSeamRoom(regionPage, [gw.label, gw.anchor, lastSeg(tgt ?? "")]);
          let room = feature;
          if (feature) {
            const ground = this.overlapGround(regionMaps, feature);
            if (ground && (await this.routeByNames(regionPage, ground, feature)).ok) room = ground;
          }
          if (room) {
            add(grid.page, { to: regionPage, exit: gw.label, entry: room });
            add(regionPage, { to: grid.page, exit: room, entry: gw.label });
          }
        }
      }
    }
    this.pageEdges = edges;
  }

  /** Find the ASCII room on `page` that a grid tile OVERLAPS, by name. Unlike a
   *  city arrival (see `bestRoomOn`), this is a strict identity match: the tile
   *  and the room are the same place, so we require at least two shared
   *  significant tokens (a full multi-word overlap like "Wolke"+"Sandmännchen")
   *  and never fall back — a weak match must yield no seam, not a wrong one. */
  private bestSeamRoom(page: string, names: (string | undefined | null)[]): string | null {
    const rooms = this.roomsByPage.get(page) ?? [];
    if (!rooms.length) return null;
    const gwTok = new Set<string>();
    for (const n of names) if (n) for (const t of roomTokens(n)) gwTok.add(t);
    if (!gwTok.size) return null;
    // Keep parentheticals — they often carry the identifying word ("Auf einer
    // Wolke (Sandmännchen)"). Only drop "-> …" wayfinding annotations.
    const clean = (n: string) => deumlaut(n).replace(/->.*$/, "").trim();
    let best: string | null = null, bestScore = 1; // require ≥2 shared tokens
    for (const name of rooms) {
      const rt = roomTokens(clean(name));
      let k = 0;
      for (const rtok of rt) if ([...gwTok].some((a) => a.includes(rtok) || rtok.includes(a))) k++;
      if (k > bestScore) { bestScore = k; best = name; }
    }
    return best;
  }

  /** The ground room that overlaps the overworld on the same sub-map as
   *  `feature`: the room whose legend links to the worldmap ("#Karte"). You step
   *  off the overworld onto THIS room (e.g. "Pfad im Gebirge"), then the ASCII
   *  map handles the final hop onto the feature ("Auf einer Wolke" is one "hoch"
   *  up). Returns null when the sub-map has no such worldmap-linked room. */
  private overlapGround(maps: PageMap[], feature: string): string | null {
    const fd = deumlaut(feature);
    const sub = maps.find((m) => m.legend.some(([, n]) => n && deumlaut(n) === fd));
    if (!sub) return null;
    const nameOf = new Map(sub.legend);
    const anchorsOf = new Map(sub.anchors);
    const onWorldmap = (label: string) => (anchorsOf.get(label) ?? []).some((a) => /karte/i.test(a));
    // The elevated-feature case (a "Wolke" reached by "hoch") is the exception,
    // not the rule: only redirect when the feature is NOT itself on the worldmap
    // but another room on its sub-map is. If the feature sits on the worldmap,
    // step onto it directly — don't invent a detour through a sibling room.
    const featLabel = sub.legend.find(([, n]) => n && deumlaut(n) === fd)?.[0];
    if (featLabel && onWorldmap(featLabel)) return null;
    for (const [label] of sub.legend) {
      if (!onWorldmap(label)) continue;
      const n = nameOf.get(label);
      if (n && deumlaut(n) !== fd) return n;
    }
    return null;
  }

  /** Pick the arrival room on a city map `page` for a grid gateway. You enter a
   *  city at its gate, so prefer an actual entrance (Tor/Eingang/Stadtmauer/…),
   *  then token overlap with the gateway name. Crucially, match against the room
   *  name with any "-> Ziel" wayfinding annotation and parenthetical stripped, so
   *  a room like "Bergschrein (Gemälde -> Foo-Ling-Yoo)" is NOT mistaken for the
   *  Foo-Ling-Yoo entrance. Falls back to the primary (lowest-numbered) room. */
  private bestRoomOn(page: string, q: string): string | null {
    const rooms = this.roomsByPage.get(page) ?? [];
    if (!rooms.length) return null;
    // Drop "-> …" wayfinding hints and parentheticals before matching on names.
    const clean = (n: string) => deumlaut(n).replace(/->.*$/, "").replace(/\(.*$/, "").trim();
    // Match the gate stem with an optional plural suffix ("Stadttore", "Tore").
    const isGate = (n: string) => /\b(stadttor|tor|tuer|eingang|stadtmauer|hafen|portal|pforte)(e|en|s)?\b/.test(clean(n));
    const qd = deumlaut(q), qTok = roomTokens(q);
    let best: string | null = null, bestScore = -1;
    for (const name of rooms) {
      const c = clean(name);
      let score = 0;
      if (c && tokenOverlap(qTok, c)) score += 2;
      if (c && (c.includes(qd) || qd.includes(c))) score += 2;
      if (isGate(name)) score += 3; // an entrance is where you arrive from the overworld
      if (score > bestScore) { bestScore = score; best = name; }
    }
    return bestScore > 0 ? best : rooms[0];
  }

  /**
   * Route across several ASCII map pages. Finds the shortest chain of pages from
   * a page containing `fromQ` to one containing `toQ` (BFS over the reciprocal
   * gateway graph), then stitches the per-page routes together, inserting a
   * crossing step at every page boundary. Used as a fallback when no single page
   * holds both endpoints.
   */
  async routeCrossPage(fromQ: string, toQ: string, maxPages = 5): Promise<RouteResult> {
    await this.ensurePageGraph();
    const fc = this.candidates(fromQ), tc = this.candidates(toQ);
    // Anchor both ends to their credible pages (verbatim name, else hint-pinned)
    // so BFS starts from the real origin map and stops at the real destination —
    // not at the nearest page that merely shares a generic room name.
    // An overworld/grid page rarely holds the specific endpoint room — its named
    // tiles are gateways into cities/areas, and the fine-grained destination (a
    // Wolke, a Tempelraum) lives on the ASCII area page it links to. So when an
    // endpoint also matches a normal (non-grid) page, treat the grid twin as
    // TRANSIT, not a terminal: BFS then continues through the overworld into the
    // ASCII page where the room actually is, instead of dead-ending on the grid.
    const preferAscii = (pages: Iterable<string>): Set<string> => {
      const all = [...pages];
      const ascii = all.filter((p) => !this.gridByPage.has(p));
      return new Set(ascii.length ? ascii : all);
    };
    const starts = preferAscii(this.endpointPages(fromQ).keys());
    const dests = preferAscii(this.endpointPages(toQ).keys());
    if (!starts.size || !dests.size) return { ok: false };
    // BFS over pages (shortest number of maps). Multi-source from every start
    // page; stop at the first dest page that is not itself a start page.
    const prev = new Map<string, { from: string; edge: PageEdge } | null>();
    const depth = new Map<string, number>();
    const q: string[] = [];
    for (const s of starts) { prev.set(s, null); depth.set(s, 1); q.push(s); }
    let goal: string | null = null;
    while (q.length) {
      const cur = q.shift()!;
      if (dests.has(cur) && !starts.has(cur)) { goal = cur; break; }
      if ((depth.get(cur) ?? 0) >= maxPages) continue;
      for (const e of this.pageEdges!.get(cur) ?? []) {
        if (!prev.has(e.to)) { prev.set(e.to, { from: cur, edge: e }); depth.set(e.to, (depth.get(cur) ?? 0) + 1); q.push(e.to); }
      }
    }
    if (!goal) return { ok: false };
    // Reconstruct the page chain: [{P0}, {P1,edge0}, …]; edge_i connects P_{i-1}→P_i.
    const chain: { page: string; edge?: PageEdge }[] = [];
    let cur: string | null = goal;
    while (cur !== null) {
      const link: { from: string; edge: PageEdge } | null = prev.get(cur) ?? null;
      chain.unshift({ page: cur, edge: link?.edge });
      cur = link ? link.from : null;
    }
    // Stitch per-page legs. The destination page often has several disconnected
    // ASCII sub-maps, and BFS records only ONE entry edge into it — which may
    // land on the wrong sub-map. So try EVERY edge from the penultimate page
    // into the goal (the final seam) and keep the first whose legs all connect.
    // A grid page and its ASCII area page share a slug ("karte/märchenland" vs
    // "märchenland"); label the overworld one distinctly so a trip that crosses
    // both doesn't show two identical "nach Märchenland" transitions.
    const areaName = (slug: string) => {
      const name = slug.split("/").pop()!.replace(/-/g, " ");
      return this.gridByPage.has(slug) ? `Überlandkarte ${name}` : name;
    };
    const stitch = async (edges: (PageEdge | undefined)[]): Promise<RouteResult | null> => {
      const steps: RouteStep[] = [];
      const asciiParts: string[] = [];
      for (let i = 0; i < chain.length; i++) {
        const page = chain[i].page;
        const entry = i === 0 ? null : edges[i]!.entry; // arrive here
        const exit = i === chain.length - 1 ? null : edges[i + 1]!.exit; // leave here
        const fromForms = i === 0 ? fc.forms : [entry!];
        const toForms = i === chain.length - 1 ? tc.forms : [exit!];
        const leg = await this.routeByForms(page, fromForms, toForms);
        if (!leg.ok) return null; // this page-path doesn't actually connect
        const legSteps = leg.steps ?? [];
        // A map seam is a normal walk, not a separate action: annotate the step that
        // carries you across (the first move on the new map) rather than inserting a
        // directionless teleport step. If the new leg has no move of its own (you
        // enter exactly at its gateway room), hang the note on the previous step; only
        // a truly step-less crossing falls back to a bare marker.
        if (i > 0) {
          const label = `Übergang nach ${areaName(page)} (${entry})`;
          if (legSteps.length) legSteps[0] = { ...legSteps[0], transition: label };
          else if (steps.length) steps[steps.length - 1] = { ...steps[steps.length - 1], transition: label };
          else steps.push({ dir: null, hidden: false, transition: label, toName: entry });
        }
        steps.push(...legSteps);
        if (leg.ascii) asciiParts.push(`— ${areaName(page)} —\n${leg.ascii}`);
      }
      const clear = steps.every((x) => !x.hidden && (x.dir || x.transition));
      return { ok: true, from: fromQ, to: toQ, steps, clear, ascii: asciiParts.join("\n\n") };
    };
    const baseEdges = chain.map((c) => c.edge);
    const finalSeams = chain.length > 1
      ? (this.pageEdges!.get(chain[chain.length - 2].page) ?? []).filter((e) => e.to === goal)
      : [];
    const tries = finalSeams.length ? finalSeams : [baseEdges[baseEdges.length - 1]];
    for (const fe of tries) {
      const res = await stitch([...baseEdges.slice(0, -1), fe]);
      if (res) return res;
    }
    return { ok: false };
  }

  /** The slug of `name` if it names a map page (its own area, e.g. "Borsippa"),
   *  else null. */
  private mapPageSlug(name: string): string | null {
    const n = deumlaut(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (!n) return null;
    for (const p of this.roomsByPage.keys()) if (p.split("/").pop() === n) return n;
    return null;
  }

  /** True if `name` corresponds to a map page (its own area), e.g. "Borsippa". */
  private hasMapPage(name: string): boolean {
    return this.mapPageSlug(name) !== null;
  }

  /** Try to route on ONE page, resolving endpoints via findNode over the query
   *  forms (raw + qualifier-stripped). Scoped to a single page, so substring
   *  matching can't drift to a coincidentally-named room elsewhere. */
  private async routeByForms(page: string, fromForms: string[], toForms: string[]): Promise<RouteResult> {
    for (const f of fromForms) for (const t of toForms) {
      const r = await this.routeByNames(page, f, t);
      if (r.ok) return r;
    }
    return { ok: false };
  }

  /** Gather candidate area pages and their ASCII sub-maps for a "show me the map
   *  of X" request. Code only GATHERS (which pages plausibly match, and what
   *  sub-maps they hold); the LLM picks the one the user means — same split as
   *  `routeCandidates`. Each sub-map lists its heading + a few legend rooms. */
  async mapCandidates(areaQ: string): Promise<{ page: string; maps: { anchor: string; rooms: string[] }[] }[]> {
    const { forms, hint } = this.candidates(areaQ);
    const slug = (s: string) => deumlaut(s).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const lastSeg = (p: string) => p.split("/").pop()!;
    const pages = new Set<string>();
    for (const f of forms) { const sl = slug(f); if (sl) for (const p of this.roomsByPage.keys()) if (lastSeg(p) === sl) pages.add(p); }
    if (hint) for (const p of this.roomsByPage.keys()) if (lastSeg(p) === hint) pages.add(p);
    const qTok = roomTokens(forms[forms.length - 1]);
    if (qTok.length) for (const r of this.rooms) if (tokenOverlap(qTok, r.name)) pages.add(r.page);
    const ordered = [...pages]
      .sort((a, b) => Number(lastSeg(b) === hint) - Number(lastSeg(a) === hint))
      .slice(0, 4);
    const out: { page: string; maps: { anchor: string; rooms: string[] }[] }[] = [];
    for (const page of ordered) {
      const grid = this.gridByPage.get(page);
      if (grid) {
        out.push({ page, maps: [{ anchor: grid.region, rooms: grid.gateways.map((g) => g.label).slice(0, 14) }] });
        continue;
      }
      const file = path.join(path.resolve(config.kbDir), `${page}.md`);
      if (!existsSync(file)) continue;
      const maps = pageMaps(await readFile(file, "utf8"))
        .filter((m) => m.anchor) // a named sub-map the LLM can refer to
        .map((m) => ({ anchor: m.anchor, rooms: m.rooms.filter(Boolean).slice(0, 14) }));
      if (maps.length) out.push({ page, maps });
    }
    return out;
  }

  /** Render ONE named ASCII sub-map (its art + legend) on a page — the
   *  deterministic half once the LLM has chosen page + heading anchor. */
  async renderNamedMap(page: string, anchorQ: string): Promise<{ area: string; block: string } | null> {
    const grid = this.gridByPage.get(page);
    if (grid) return { area: grid.region, block: renderGridAscii(grid) };
    const file = path.join(path.resolve(config.kbDir), `${page}.md`);
    if (!existsSync(file)) return null;
    const maps = pageMaps(await readFile(file, "utf8"));
    const a = deumlaut(anchorQ);
    const m =
      maps.find((x) => deumlaut(x.anchor) === a) ??
      maps.find((x) => x.anchor && (deumlaut(x.anchor).includes(a) || a.includes(deumlaut(x.anchor))));
    if (!m) return null;
    const legend = m.legend.filter(([, n]) => n).map(([l, n]) => `${l} ${n}`).join("\n");
    return { area: m.anchor, block: m.ascii + (legend ? `\n\n${legend}` : "") };
  }

  /** Compute a route between two EXACT room names on a known page. Grid (raster
   *  overworld) pages route over their tile graph; ASCII pages over their art. */
  async routeByNames(page: string, from: string, to: string): Promise<RouteResult> {
    const grid = this.gridByPage.get(page);
    if (grid) return routeOnGrid(grid, from, to);
    const file = path.join(path.resolve(config.kbDir), `${page}.md`);
    if (!existsSync(file)) return { ok: false, error: "Kartenseite nicht gefunden" };
    return routeOnPage(await readFile(file, "utf8"), from, to, (await this.ensureClimbHints()).get(page));
  }

  /** Resolve both endpoints to a shared area page and compute the route. */
  async route(fromQ: string, toQ: string): Promise<RouteResult> {
    const fc = this.candidates(fromQ), tc = this.candidates(toQ);
    // try the most specific forms first, falling back to qualifier-stripped ones
    let fp = new Set<string>(), tp = new Set<string>(), usedFrom = fromQ, usedTo = toQ;
    outer: for (const f of fc.forms) for (const t of tc.forms) {
      const a = this.pagesFor(f), b = this.pagesFor(t);
      if ([...a].some((p) => b.has(p))) { fp = a; tp = b; usedFrom = f; usedTo = t; break outer; }
    }
    let common = [...fp].filter((p) => tp.has(p));
    if (!common.length) return { ok: false, error: "Start und Ziel nicht in derselben Gebietskarte gefunden" };
    // a location hint ("… in Tadmor") disambiguates which shared page to use
    const hint = tc.hint ?? fc.hint;
    const page = (hint && common.find((p) => deumlaut(p).includes(hint))) || common[0];
    fromQ = usedFrom; toQ = usedTo;
    const file = path.join(path.resolve(config.kbDir), `${page}.md`);
    if (!existsSync(file)) return { ok: false, error: "Kartenseite nicht gefunden" };
    return routeOnPage(await readFile(file, "utf8"), fromQ, toQ, (await this.ensureClimbHints()).get(page));
  }
}

export async function loadNavIndex(): Promise<NavIndex | null> {
  if (!existsSync(navPath())) return null;
  try { return new NavIndex(JSON.parse(await readFile(navPath(), "utf8"))); }
  catch { return null; }
}
