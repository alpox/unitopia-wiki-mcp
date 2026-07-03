import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { listRooms, routeOnPage, pageMaps, pageLinks, deumlaut, roomTokens, tokenOverlap, type RouteResult, type RouteStep } from "./mapGraph.js";
import { routeOnGrid, renderGridAscii } from "./grid/gridRouter.js";
import type { GridMap } from "./grid/types.js";

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

  private pagesFor(q: string): Set<string> {
    const ql = deumlaut(q);
    const out = new Set<string>();
    for (const r of this.rooms) if (deumlaut(r.name).includes(ql)) out.add(r.page);
    return out;
  }

  /** Candidate forms of an endpoint: the raw query, then with a trailing
   *  location qualifier ("… in/im/von/bei Tadmor") stripped. The stripped word
   *  is also returned as a page hint. */
  private candidates(q: string): { forms: string[]; hint: string | null } {
    const forms = [q.trim()];
    let hint: string | null = null;
    const m = /^(.*\S)\s+(?:in|im|von|vom|bei|auf|am|an)\s+(\S[\w äöüÄÖÜß-]*)$/i.exec(q.trim());
    if (m) { forms.push(m[1].trim()); hint = deumlaut(m[2]); }
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
  async resolveAndRoute(fromQ: string, toQ: string): Promise<RouteResult & { ambiguous?: boolean }> {
    const fc = this.candidates(fromQ), tc = this.candidates(toQ);
    const hint = tc.hint ?? fc.hint;
    const fm = this.endpointPages(fromQ), tm = this.endpointPages(toQ);
    const shared = [...fm.keys()].filter((p) => tm.has(p));
    // No single page holds both endpoints → the trip spans several maps.
    if (!shared.length) return this.routeCrossPage(fromQ, toQ);
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
    for (const grid of this.gridByPage.values()) {
      for (const gw of grid.gateways) {
        const tgt = gw.target;
        if (!tgt || tgt === grid.page || !isMapPage(tgt)) continue;
        const cityRoom = this.bestRoomOn(tgt, gw.anchor ?? gw.label) ?? gw.label;
        add(grid.page, { to: tgt, exit: gw.label, entry: cityRoom }); // enter the city
        add(tgt, { to: grid.page, exit: cityRoom, entry: gw.label }); // step back onto the overworld
      }
    }
    this.pageEdges = edges;
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
    const isGate = (n: string) => /\b(tor|tuer|eingang|stadtmauer|stadttor|hafen|portal|pforte)\b/.test(clean(n));
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
    const starts = new Set(this.endpointPages(fromQ).keys());
    const dests = new Set(this.endpointPages(toQ).keys());
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
    // Stitch per-page legs.
    const steps: RouteStep[] = [];
    const asciiParts: string[] = [];
    const areaName = (slug: string) => slug.split("/").pop()!.replace(/-/g, " ");
    for (let i = 0; i < chain.length; i++) {
      const page = chain[i].page;
      const entry = i === 0 ? null : chain[i].edge!.entry; // arrive here
      const exit = i === chain.length - 1 ? null : chain[i + 1].edge!.exit; // leave here
      const fromForms = i === 0 ? fc.forms : [entry!];
      const toForms = i === chain.length - 1 ? tc.forms : [exit!];
      const leg = await this.routeByForms(page, fromForms, toForms);
      if (!leg.ok) return { ok: false }; // this page-path doesn't actually connect
      if (i > 0) steps.push({ dir: null, hidden: false, transition: `Übergang nach ${areaName(page)} (${entry})`, toName: entry });
      steps.push(...(leg.steps ?? []));
      if (leg.ascii) asciiParts.push(`— ${areaName(page)} —\n${leg.ascii}`);
    }
    return {
      ok: true,
      from: fromQ,
      to: toQ,
      steps,
      clear: false, // a cross-page trip always has crossings
      ascii: asciiParts.join("\n\n"),
    };
  }

  /** True if `name` corresponds to a map page (its own area), e.g. "Borsippa". */
  private hasMapPage(name: string): boolean {
    const n = deumlaut(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (!n) return false;
    for (const p of this.roomsByPage.keys()) if (p.split("/").pop() === n) return true;
    return false;
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
    return routeOnPage(await readFile(file, "utf8"), from, to);
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
    return routeOnPage(await readFile(file, "utf8"), fromQ, toQ);
  }
}

export async function loadNavIndex(): Promise<NavIndex | null> {
  if (!existsSync(navPath())) return null;
  try { return new NavIndex(JSON.parse(await readFile(navPath(), "utf8"))); }
  catch { return null; }
}
