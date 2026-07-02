import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { listRooms, routeOnPage, pageMaps, deumlaut, roomTokens, tokenOverlap, type RouteResult } from "./mapGraph.js";

/**
 * Builds and serves a room→page index so a "wie komme ich von X nach Y" query
 * can find the area page whose maps contain both rooms, then route on it.
 */
const RESERVED = new Set(["index.md", "log.md"]);
const NAV_FILE = "navrooms.json";
const navPath = () => path.join(config.indexDir, NAV_FILE);

interface NavRooms { rooms: { page: string; name: string }[] }

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
  return { rooms };
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

export class NavIndex {
  private rooms: { page: string; name: string }[];
  private roomsByPage = new Map<string, string[]>();
  constructor(data: NavRooms) {
    this.rooms = data.rooms;
    for (const r of data.rooms) {
      const a = this.roomsByPage.get(r.page);
      if (a) a.push(r.name);
      else this.roomsByPage.set(r.page, [r.name]);
    }
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
   *  matches per page (over the raw + qualifier-stripped query forms). */
  private matchesByPage(q: string): Map<string, { exact: Set<string>; sub: Set<string> }> {
    const { forms } = this.candidates(q);
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
    const fm = this.matchesByPage(fromQ), tm = this.matchesByPage(toQ);
    const shared = [...fm.keys()].filter((p) => tm.has(p));
    if (!shared.length) return { ok: false };
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
    return { ok: false, ambiguous: !tried || scored.length > 0 };
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

  /** Compute a route between two EXACT room names on a known page. */
  async routeByNames(page: string, from: string, to: string): Promise<RouteResult> {
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
