/**
 * Routing + rendering over a parsed overworld `GridMap`.
 *
 * Every tile is a node; each connects to its 8 in-bounds neighbours. Edge cost
 * is the destination tile's terrain cost (roads cheapest, open sea dear), with a
 * small discount for continuing along a road's direction — so routes hug roads,
 * exactly the "ways are safer, prefer them" behaviour the user asked for.
 * Reuses the same weighted-Dijkstra shape as the ASCII router (mapGraph.ts).
 */

import { deumlaut, type RouteResult, type RouteStep } from "../mapGraph.js";
import { OFF } from "./tileGrid.js";
import type { Dir, GridMap } from "./types.js";

const COMPASS: Record<Dir, string> = {
  E: "osten", W: "westen", N: "norden", S: "sueden",
  NE: "nordosten", SW: "suedwesten", NW: "nordwesten", SE: "suedosten",
};
const DIRS = Object.keys(OFF) as Dir[];

const key = (c: number, r: number) => `${c},${r}`;
const walkable = (g: GridMap, c: number, r: number) =>
  c >= 0 && r >= 0 && c < g.cols && r < g.rows && !g.blocked?.[r]?.[c];

const WET = new Set(["water", "ocean"]);
/** You can swim ~this many tiles safely; a longer continuous swim is deadly. */
const WATER_LIMIT = 3;
/** Prohibitive surcharge for the tile that would push a swim past the limit. */
const DROWN = 1000;
/** Dijkstra state = tile + how many water tiles we've crossed back-to-back. */
const stateKey = (c: number, r: number, run: number) => `${c},${r},${run}`;

/** Resolve an endpoint query to a tile: an explicit "col,row", a gateway (by
 *  label or target-page), or the region name (→ a central walkable tile). */
export function resolveTile(g: GridMap, q: string): { col: number; row: number; name: string } | null {
  const cr = /^\s*(\d+)\s*[,;]\s*(\d+)\s*$/.exec(q);
  if (cr) return { col: +cr[1], row: +cr[2], name: `${cr[1]},${cr[2]}` };
  // Separator-insensitive, word-boundary normalization (as in NavIndex): so a
  // gateway "Nurikomoon-Tempel" is matched by a query "Nurikomoon Tempel".
  const norm = (s: string) => ` ${deumlaut(s).replace(/[^a-z0-9]+/g, " ").trim()} `;
  const ql = norm(q);
  const lastSeg = (p: string) => p.split("/").pop() ?? p;
  // Prefer an exact-ish gateway label match, then a target-page match.
  let best: { col: number; row: number; name: string } | null = null;
  let bestScore = 0;
  for (const gw of g.gateways) {
    const label = norm(gw.label);
    const tgt = gw.target ? norm(lastSeg(gw.target)) : "";
    let score = 0;
    if (label === ql) score = 5;
    else if (label.includes(ql) || ql.includes(label)) score = 3;
    // An EXACT target-page match is as authoritative as an exact label: a gateway
    // whose target IS the queried city is its entrance. This matters once a city's
    // single "Lutetia" point gateway is replaced by per-side "Lutetia (Westrand 1)"
    // entrances — the bare label no longer scores 5, but the exact target still does,
    // so "Lutetia" still resolves to an entrance rather than tying with the harbour.
    if (tgt && tgt === ql) score = Math.max(score, 5);
    else if (tgt && (ql.includes(tgt) || tgt.includes(ql))) score = Math.max(score, 4);
    if (score > bestScore) { bestScore = score; best = { col: gw.col, row: gw.row, name: gw.label }; }
  }
  if (best) return best;
  return regionAnchor(g, ql, norm);
}

/** Like `resolveTile` but returns ALL top-scoring gateway tiles — a city with several
 *  entrance gateways ("Lutetia (Westrand 1)"/"(Ostrand 1)") resolves to every gate, so
 *  the router can head for the NEAREST rather than an arbitrary first-listed one (which
 *  can sit across a river). Falls back to the single `resolveTile` result otherwise. */
export function resolveTiles(g: GridMap, q: string): { col: number; row: number; name: string }[] {
  const cr = /^\s*(\d+)\s*[,;]\s*(\d+)\s*$/.exec(q);
  if (cr) return [{ col: +cr[1], row: +cr[2], name: `${cr[1]},${cr[2]}` }];
  const norm = (s: string) => ` ${deumlaut(s).replace(/[^a-z0-9]+/g, " ").trim()} `;
  const ql = norm(q);
  const lastSeg = (p: string) => p.split("/").pop() ?? p;
  const scored: { col: number; row: number; name: string; score: number }[] = [];
  for (const gw of g.gateways) {
    const label = norm(gw.label);
    const tgt = gw.target ? norm(lastSeg(gw.target)) : "";
    let score = 0;
    if (label === ql) score = 5;
    else if (label.includes(ql) || ql.includes(label)) score = 3;
    if (tgt && tgt === ql) score = Math.max(score, 5);
    else if (tgt && (ql.includes(tgt) || tgt.includes(ql))) score = Math.max(score, 4);
    if (score > 0) scored.push({ col: gw.col, row: gw.row, name: gw.label, score });
  }
  const max = Math.max(0, ...scored.map((s) => s.score));
  const top = scored.filter((s) => s.score === max).map(({ col, row, name }) => ({ col, row, name }));
  if (top.length) return top;
  const reg = regionAnchor(g, ql, norm);
  return reg ? [reg] : [];
}

/** The generic whole-area anchor: the central, cheapest walkable tile, when a query
 *  names the region itself rather than a gateway. */
function regionAnchor(g: GridMap, ql: string, norm: (s: string) => string): { col: number; row: number; name: string } | null {
  const reg = norm(g.region);
  if (reg === ql || ql.includes(reg)) {
    // Central walkable, cheapest tile as a generic anchor for the whole area.
    let pick: { col: number; row: number; name: string } | null = null, pc = Infinity;
    const midC = g.cols / 2, midR = g.rows / 2;
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
      if (g.tiles[r][c] === "ocean") continue;
      const d = Math.abs(c - midC) + Math.abs(r - midR) + g.cost[r][c] * 2;
      if (d < pc) { pc = d; pick = { col: c, row: r, name: g.region }; }
    }
    return pick;
  }
  return null;
}

/** Route between two endpoints on a single grid map. */
export function routeOnGrid(g: GridMap, fromQ: string, toQ: string): RouteResult {
  const s = resolveTile(g, fromQ);
  // The destination may resolve to SEVERAL equally-named gates (a city's per-side
  // entrances); head for whichever is nearest by land, so the router doesn't swim to
  // an arbitrary first-listed gate across a river.
  const targets = resolveTiles(g, toQ).filter((t) => walkable(g, t.col, t.row));
  if (!s || !targets.length) return { ok: false, error: `Ort nicht auf der Karte gefunden: ${!s ? fromQ : toQ}` };
  if (!walkable(g, s.col, s.row)) return { ok: false, error: "Koordinate außerhalb der Karte" };
  const goalAt = new Map(targets.map((t) => [key(t.col, t.row), t.name]));
  // Per-tile blocked compass directions, from marcopolo's edges at injected entrance gates.
  const edgeBlock = new Map<string, Set<string>>();
  for (const gw of g.gateways) if (gw.blockedDirs?.length) edgeBlock.set(key(gw.col, gw.row), new Set(gw.blockedDirs));

  // Search over (tile, waterRun) states so a long continuous swim can be made
  // deadly while a short crossing stays cheap. The start tile has run 0.
  const sK = stateKey(s.col, s.row, 0);
  const dist = new Map<string, number>([[sK, 0]]);
  const prev = new Map<string, { from: string; dir: Dir } | null>([[sK, null]]);
  const done = new Set<string>();
  const pq = [sK];
  let goalState: string | null = null;
  while (pq.length) {
    let bi = 0;
    for (let k = 1; k < pq.length; k++) if ((dist.get(pq[k]) ?? Infinity) < (dist.get(pq[bi]) ?? Infinity)) bi = k;
    const cur = pq.splice(bi, 1)[0];
    if (done.has(cur)) continue; done.add(cur);
    const [cc, cr, run] = cur.split(",").map(Number);
    if (goalAt.has(key(cc, cr))) { goalState = cur; break; }
    const srcRoad = g.roadDirs[cr][cc];
    for (const d of DIRS) {
      const [dr, dc] = OFF[d];
      const nc = cc + dc, nr = cr + dr;
      if (!walkable(g, nc, nr)) continue;
      // marcopolo's EXACT edges at an entrance tile: the gate's connector glyphs say which
      // moves the road actually makes (e.g. Lutetia's east gate has no NE edge). Applied
      // by SIDE at the injected gateway tile, so the router leaves a city the way the map
      // draws it, not on a shortcut diagonal.
      if (edgeBlock.get(key(cc, cr))?.has(COMPASS[d])) continue;
      // No diagonal corner-cutting past a blocked footprint: a diagonal step clipping the
      // corner of the solid city body is not a real move (marcopolo `X`es it).
      if (dr !== 0 && dc !== 0 && (g.blocked?.[cr]?.[nc] || g.blocked?.[nr]?.[cc])) continue;
      const wet = WET.has(g.tiles[nr][nc]);
      const newRun = wet ? run + 1 : 0;
      let w = g.cost[nr][nc];
      if (srcRoad.includes(d)) w -= 0.1; // gentle pull to follow the road
      if (wet && newRun > WATER_LIMIT) w += DROWN; // one swim-tile too far → deadly
      const nd = (dist.get(cur) ?? Infinity) + w;
      const nk = stateKey(nc, nr, Math.min(newRun, WATER_LIMIT + 1));
      if (nd < (dist.get(nk) ?? Infinity)) { dist.set(nk, nd); prev.set(nk, { from: cur, dir: d }); pq.push(nk); }
    }
  }
  if (!goalState) return { ok: false, error: "kein Weg auf der Karte gefunden" };

  const gwAt = new Map(g.gateways.map((gw) => [key(gw.col, gw.row), gw.label]));
  const steps: RouteStep[] = [];
  const path: [number, number][] = [];
  let cur = goalState;
  path.unshift(t2(cur));
  while (prev.get(cur)) {
    const { from, dir } = prev.get(cur)!;
    const [cc, cr] = t2(cur);
    // Tag a step that lands on water: crossing a river (e.g. swimming AROUND a
    // blocked city to reach its far gate) is physically allowed but should lose to
    // an all-land approach, so the cross-page seam picker can penalise it.
    steps.unshift({ dir: COMPASS[dir], hidden: false, transition: null, toName: gwAt.get(t3(cur)) ?? null, wet: WET.has(g.tiles[cr][cc]) });
    path.unshift(t2(from));
    cur = from;
  }
  const [gc, gr] = t2(goalState);
  return {
    ok: true, from: s.name, to: goalAt.get(key(gc, gr)) ?? toQ, steps,
    clear: steps.every((x) => x.dir),
    ascii: renderPath(g, path),
  };
}

function t2(k: string): [number, number] { const [c, r] = k.split(",").map(Number); return [c, r]; }
/** Tile ("c,r") part of a state key ("c,r,run"). */
function t3(k: string): string { const [c, r] = k.split(","); return `${c},${r}`; }

const GLYPH: Record<string, string> = {
  ocean: " ", grass: ".", forest: ",", rock: "^", sand: "°", water: "~", road: "=", other: ":",
};

/** Render the whole map as ASCII: terrain glyphs, numbered gateway markers and a
 *  legend. Used for the shipped `.md` and the `map` MCP tool. */
export function renderGridAscii(g: GridMap): string {
  const rows = g.tiles.map((row) => row.map((t) => GLYPH[t] ?? "?"));
  const legend: string[] = [];
  g.gateways.forEach((gw, i) => {
    const n = (i + 1) % 10 === i + 1 ? String(i + 1) : String.fromCharCode(97 + ((i - 9) % 26));
    if (rows[gw.row] && rows[gw.row][gw.col] !== undefined) rows[gw.row][gw.col] = n;
    legend.push(`${n} ${gw.label}${gw.target ? ` → ${gw.target}` : ""}`);
  });
  const art = rows.map((r) => r.join("")).join("\n");
  return `${art}\n\nZeichen: .=Wiese ,=Wald ^=Fels ~=Wasser ==Weg (leer)=Meer\n${legend.join("\n")}`;
}

/** Small ASCII excerpt of a computed path, cropped to its bounding box. */
function renderPath(g: GridMap, path: [number, number][]): string {
  let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
  for (const [c, r] of path) { minC = Math.min(minC, c); maxC = Math.max(maxC, c); minR = Math.min(minR, r); maxR = Math.max(maxR, r); }
  const pad = 1;
  minC = Math.max(0, minC - pad); minR = Math.max(0, minR - pad);
  maxC = Math.min(g.cols - 1, maxC + pad); maxR = Math.min(g.rows - 1, maxR + pad);
  const onPath = new Set(path.map(([c, r]) => key(c, r)));
  const lines: string[] = [];
  for (let r = minR; r <= maxR; r++) {
    let line = "";
    for (let c = minC; c <= maxC; c++) line += onPath.has(key(c, r)) ? "*" : (GLYPH[g.tiles[r][c]] ?? "?");
    lines.push(line);
  }
  return lines.join("\n");
}
