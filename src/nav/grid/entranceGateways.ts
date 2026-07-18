/**
 * Synthesize overworld→sub-map ENTRANCE gateways for a raster (gif) region.
 *
 * The wiki gif marks a forest/area with a SINGLE gateway tile and no footprint, so
 * the router can only ever enter at that one point — forcing long detours "around
 * half the forest". But the wiki sub-map itself lists every real penetrable
 * entrance (its "1 Rand → /region.md" edge rooms), and the marcopolo overworld
 * marks WHERE each of those entrances sits. This module ties the two together:
 *
 *   wiki edge room  (side, ordinal)   ── same physical entrance ──   marcopolo
 *   overworld cell  (side, ordinal, marco-coord)  ──affine──▶  gif tile
 *
 * and emits one Gateway per entrance (each pinning its specific "1" room by
 * coordinate), so grid Dijkstra enters the wald at the side you actually approach.
 * marcopolo is used ONLY for position; penetrability comes from the wiki. General:
 * fires for any gif region with a marcopolo overworld + ≥3 shared landmarks; a
 * region without them keeps today's single-gate behavior. See
 * [[overworld-ascii-entrance-seam]].
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { GridMap, Gateway } from "./types.js";
import { subMapEntrances, perimeterRooms, deumlaut, type SubMapEntrance, type PerimeterRoom } from "../mapGraph.js";
import { parseMcOkf } from "../marcopolo/okf.js";
import { penetrableEntrances, bySide, borderGateTokens, type McEntrance, type Side } from "../marcopolo/entrances.js";
interface Bbox { minC: number; maxC: number; minR: number; maxR: number; }

/** The overworld footprint of a sub-map, read from the BAKED `grid.subMaps` (the
 *  imagemap wikitext is not shipped in the KB tarball, so the footprint must travel
 *  inside the grid artifact). Expands the tile boxes into a tile set + bounding box —
 *  the blocked ASCII-map body the gif paints as walkable grass. Returns null when the
 *  sub-map has no footprint (an ordinary point gateway — a city — has nothing to
 *  block). */
function footprintOf(grid: GridMap, target: string): { tiles: Set<string>; bbox: Bbox } | null {
  // Match the sub-map by EXACT last path segment first: `normSlug` strips a
  // `kompass-` prefix, so `lutetia` and its harbour-compass twin `kompass-lutetia`
  // both normalise to "lutetia" and collide — blocking the wrong (tiny) footprint.
  // The exact-slug match keeps them apart; normSlug is only a fallback.
  const t = lastSeg(target).replace(/\.md$/, "");
  const sm = grid.subMaps?.find((s) => lastSeg(s.target).replace(/\.md$/, "") === t)
    ?? grid.subMaps?.find((s) => normSlug(s.target) === normSlug(target));
  if (!sm) return null;
  const tiles = new Set<string>();
  let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
  for (const [c1, r1, c2, r2] of sm.boxes)
    for (let c = Math.max(0, c1); c <= Math.min(grid.cols - 1, c2); c++)
      for (let rr = Math.max(0, r1); rr <= Math.min(grid.rows - 1, r2); rr++) {
        tiles.add(`${rr},${c}`);
        minC = Math.min(minC, c); maxC = Math.max(maxC, c); minR = Math.min(minR, rr); maxR = Math.max(maxR, rr);
      }
  return tiles.size ? { tiles, bbox: { minC, maxC, minR, maxR } } : null;
}

/** Place an entrance just OUTSIDE the gif footprint on `side`, at the marcopolo
 *  overworld position of the entrance mapped through the region affine. marcopolo's
 *  overworld is GEOMETRIC (unlike the wiki ascii sub-map, which is a topological
 *  schematic whose row/col spacing does NOT map linearly to the gif — that collapses
 *  several distinct entrances onto one tile, so the router enters the wrong `1 Rand`,
 *  "one tile too far north"). The affine (fit on shared landmarks, already gating the
 *  match) gives the along-edge position; the cross-axis is pinned one tile off the
 *  footprint so the crossing step is straight. Snapped to a walkable, non-footprint tile. */
function placeByAffine(grid: GridMap, fp: Bbox, affine: Affine, side: Side, e: McEntrance): [number, number] | null {
  const [gx, gy] = apply(affine, [e.col, e.row]);
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  let c: number, r: number;
  if (side === "W" || side === "E") {
    // Clamp the along-edge row to the footprint's INTERIOR span: an entrance on the
    // very top/bottom row is at a CORNER, which is not a straight crossing — the router
    // then has to step diagonally (suedosten/nordosten) onto it. Keeping it one row in
    // lets the approach cross straight (osten/westen).
    r = clamp(Math.round(gy), fp.minR + 1, fp.maxR - 1);
    c = side === "W" ? fp.minC - 1 : fp.maxC + 1;
  } else {
    c = clamp(Math.round(gx), fp.minC + 1, fp.maxC - 1);
    r = side === "N" ? fp.minR - 1 : fp.maxR + 1;
  }
  return snapFree(grid, c, r);
}

const lastSeg = (p: string) => p.split("/").pop()!;
const normSlug = (s: string) =>
  lastSeg(s).replace(/\.md$/, "").replace(/^kompass-/, "").toLowerCase();

/** A separable least-squares affine fit p → (a·p+b) on each axis independently
 *  (the gif and marcopolo grids differ only in scale + offset, no rotation). */
interface Affine { ax: number; bx: number; ay: number; by: number; }
function fitAffine(pairs: { from: [number, number]; to: [number, number] }[]): Affine | null {
  if (pairs.length < 3) return null;
  const fit1 = (get: (p: { from: [number, number]; to: [number, number] }) => [number, number]) => {
    const n = pairs.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const p of pairs) { const [x, y] = get(p); sx += x; sy += y; sxx += x * x; sxy += x * y; }
    const d = n * sxx - sx * sx;
    if (Math.abs(d) < 1e-6) return null;
    const a = (n * sxy - sx * sy) / d;
    return { a, b: (sy - a * sx) / n };
  };
  const fx = fit1((p) => [p.from[0], p.to[0]]);
  const fy = fit1((p) => [p.from[1], p.to[1]]);
  if (!fx || !fy) return null;
  return { ax: fx.a, bx: fx.b, ay: fy.a, by: fy.b };
}
const apply = (a: Affine, [x, y]: [number, number]): [number, number] => [a.ax * x + a.bx, a.ay * y + a.by];

/** Landmark pairs: gif gateways and marcopolo-overworld cells that reference the
 *  same target page (by normalized slug), giving (marco-coord → gif-coord). */
function landmarks(grid: GridMap, mcCells: { row: number; col: number; page: string }[]) {
  const gifBy = new Map<string, [number, number]>();
  for (const g of grid.gateways) if (g.target) gifBy.set(normSlug(g.target), [g.col, g.row]);
  const pairs: { from: [number, number]; to: [number, number] }[] = [];
  const seen = new Set<string>();
  for (const c of mcCells) {
    const k = normSlug(c.page);
    const gif = gifBy.get(k);
    if (gif && !seen.has(k)) { seen.add(k); pairs.push({ from: [c.col, c.row], to: gif }); }
  }
  return pairs;
}

/** Nearest walkable tile to (col,row), spiralling out — an entrance must sit on a
 *  tile the grid router can actually stand on. `avoidBlocked` also skips the sub-map
 *  footprint, so an entrance lands on the ground OUTSIDE the forest, not inside it. */
function snap(grid: GridMap, col: number, row: number, maxR = 4, avoidBlocked = false): [number, number] | null {
  const ok = (c: number, r: number) =>
    r >= 0 && r < grid.rows && c >= 0 && c < grid.cols && grid.tiles[r]?.[c] !== "ocean" &&
    !(avoidBlocked && grid.blocked?.[r]?.[c]);
  const c0 = Math.round(col), r0 = Math.round(row);
  for (let rad = 0; rad <= maxR; rad++)
    for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++)
      if (Math.max(Math.abs(dr), Math.abs(dc)) === rad && ok(c0 + dc, r0 + dr)) return [c0 + dc, r0 + dr];
  return null;
}
/** Snap avoiding both ocean and the blocked footprint. */
const snapFree = (grid: GridMap, col: number, row: number): [number, number] | null => snap(grid, col, row, 4, true);

/** Road tiles just OUTSIDE a sub-map footprint whose inward orthogonal neighbour is
 *  a footprint tile ALSO on a road — a road that genuinely crosses the boundary. A
 *  CITY (unlike a forest) is entered by road, so these crossings are its gates. Each
 *  is tagged with the footprint side it sits on; a run of adjacent crossing tiles on
 *  one side (a wide road) collapses to its middle tile so one road ≠ several gates. */
function roadCrossings(grid: GridMap, fp: { tiles: Set<string>; bbox: Bbox }): { side: Side; col: number; row: number }[] {
  const isRoad = (r: number, c: number) => grid.tiles[r]?.[c] === "road";
  const inFp = (r: number, c: number) => fp.tiles.has(`${r},${c}`);
  const { minC, maxC, minR, maxR } = fp.bbox;
  const raw: { side: Side; col: number; row: number }[] = [];
  for (let r = minR - 1; r <= maxR + 1; r++)
    for (let c = minC - 1; c <= maxC + 1; c++) {
      if (inFp(r, c) || !isRoad(r, c)) continue;
      for (const [dr, dc] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
        if (!inFp(r + dr, c + dc) || !isRoad(r + dr, c + dc)) continue;
        // The inside neighbour lies opposite the side the outside tile sits on.
        const side: Side = dc === 1 ? "W" : dc === -1 ? "E" : dr === 1 ? "N" : "S";
        raw.push({ side, col: c, row: r });
        break;
      }
    }
  // Collapse a contiguous run along one side (a wide road) into its middle tile.
  const out: { side: Side; col: number; row: number }[] = [];
  const bySideCr = new Map<Side, { side: Side; col: number; row: number }[]>();
  for (const x of raw) (bySideCr.get(x.side) ?? bySideCr.set(x.side, []).get(x.side)!).push(x);
  for (const [side, tiles] of bySideCr) {
    const axis = (t: { col: number; row: number }) => (side === "W" || side === "E" ? t.row : t.col);
    tiles.sort((a, b) => axis(a) - axis(b));
    let cluster = [tiles[0]];
    const flush = () => out.push(cluster[Math.floor(cluster.length / 2)]);
    for (let i = 1; i < tiles.length; i++) {
      if (axis(tiles[i]) - axis(tiles[i - 1]) <= 1) cluster.push(tiles[i]);
      else { flush(); cluster = [tiles[i]]; }
    }
    flush();
  }
  return out;
}

/** Entrance gateways for a CITY sub-map (a footprint entered by ROAD, not the forest's
 *  marco-positioned edges). Pipeline, all structural bar the last tiebreak:
 *   1. footprint from the gif imagemap;
 *   2. the gif ROAD-crossings of that footprint = the entrance tiles + their side;
 *   3. the marcopolo sub-map's border-exit legend — cells that LINK BACK to the region
 *      (`T,S → Gallien`) — confirms this is a real crossable city and, dropping water
 *      (Seine `S`), yields the land-gate NAME tokens ("Stadttor") used only as a tiebreak;
 *   4. the wiki entry room per crossing = the sub-map's PERIMETER room on that side whose
 *      position along the edge best matches the crossing's (side+ordinal, like the
 *      gallischer-wald `1 Rand` match) — NOT its name; a name-token hit only breaks a
 *      near-tie, since repeated labels (`W`/`Wald-3`) make names unreliable in general.
 *  Then block the footprint so the router can't cut through the city the gif paints as
 *  walkable grass. Returns [] (blocks nothing) when it is not a road-entered city.
 *  See [[overworld-ascii-entrance-seam]]. */
async function cityGateways(grid: GridMap, kbDir: string, mcOver: string, regionSlug: string, gw: Gateway): Promise<Gateway[]> {
  if (!gw.target) return [];
  const fp = footprintOf(grid, gw.target);
  if (!fp) return [];
  const crossings = roadCrossings(grid, fp);
  if (!crossings.length) return [];
  const subFile = path.join(path.dirname(mcOver), `${lastSeg(gw.target)}.md`);
  if (!existsSync(subFile)) return [];
  const sub = parseMcOkf(await readFile(subFile, "utf8"), grid.region, lastSeg(gw.target));
  // marcopolo confirms a real land gate exists (a border-exit that links back to the
  // region and is not water); its name tokens are kept only as a tiebreak.
  const tokens = borderGateTokens(sub, lastSeg(mcOver).replace(/\.md$/, ""));
  if (!tokens.length) return [];
  // Depth 6 so a room a few tiles behind the boundary (Lutetia's "Brücke", 3 tiles in
  // from the "Stadttor" gate) is still a candidate for the overlap redirect below.
  const perim = perimeterRooms(await readFile(path.join(kbDir, `${gw.target}.md`), "utf8"), 6);
  if (!perim.length) return [];
  const nameHit = (n: string) => tokens.some((t) => deumlaut(n).toLowerCase().includes(t));
  // STRUCTURAL OVERLAP. An overworld map and a sub-map physically SHARE the boundary
  // tile at an entrance (the "2-tile overlap"): the marcopolo border-exit cell that
  // links back to the region (Lutetia's `T` = "Stadttor") is that shared tile, and it
  // appears on BOTH maps. When the wiki draws that overlap tile as its own room (a
  // `nameHit` on the border-exit tokens), you do NOT stop on it — it is the same place
  // as the overworld gate you just left; you land on the first genuinely-interior room
  // one step past it (the "Brücke"), exactly as the gallierwald enters the room past its
  // shared outer edge. This is the general entrance/overlay rule — matched by the room's
  // structural correspondence to the marcopolo border-exit, not by any terrain test.
  const pastOverlap = (gate: PerimeterRoom): PerimeterRoom | null =>
    perim.filter((p) => p.side === gate.side && Math.abs(p.frac - gate.frac) < 0.06 && p.depth > gate.depth)
      .sort((a, b) => a.depth - b.depth)[0] ?? null;
  // The wiki edge room whose along-edge position best matches the crossing's; a name
  // hit only shifts a near-tie (0.12 ≈ a couple of rooms' spacing), never overriding a
  // clearly-closer room.
  const gateRoomFor = (side: Side, crossFrac: number): PerimeterRoom | null => {
    const cand = perim.filter((p) => p.side === side);
    if (!cand.length) return null;
    let best: PerimeterRoom | null = null, bestScore = Infinity;
    for (const p of cand) {
      const score = Math.abs(p.frac - crossFrac) - (nameHit(p.name) ? 0.12 : 0);
      if (score < bestScore) { bestScore = score; best = p; }
    }
    return best;
  };
  // Block the footprint: the gif paints the city as walkable grass, so an unblocked
  // route would cut straight through (and enter on a diagonal interior tile). Blocked,
  // the router must reach a road crossing — a real gate. But a city footprint often
  // OVERLAPS a neighbouring gateway (Lutetia's rect covers the "Hafen Lutetia" harbour
  // tile); blocking that tile would strand the harbour, so keep any tile occupied by a
  // gateway to a DIFFERENT target walkable.
  const keep = new Set(grid.gateways.filter((g) => g.target && g.target !== gw.target).map((g) => `${g.row},${g.col}`));
  grid.blocked ??= Array.from({ length: grid.rows }, () => new Array<boolean>(grid.cols).fill(false));
  for (const k of fp.tiles) { if (keep.has(k)) continue; const [r, c] = k.split(",").map(Number); grid.blocked[r][c] = true; }
  const frac = (v: number, lo: number, hi: number) => (hi > lo ? (v - lo) / (hi - lo) : 0.5);
  const out: Gateway[] = [];
  const usedRoom = new Set<string>();
  const bySideCross = new Map<Side, { side: Side; col: number; row: number }[]>();
  for (const x of crossings) (bySideCross.get(x.side) ?? bySideCross.set(x.side, []).get(x.side)!).push(x);
  for (const s of ["N", "E", "S", "W"] as Side[]) {
    const cs = (bySideCross.get(s) ?? []).sort((a, b) => (s === "N" || s === "S" ? a.col - b.col : a.row - b.row));
    let i = 0;
    for (const t of cs) {
      // Position of the crossing along its edge, normalised within the footprint bbox —
      // the same 0..1 axis `perimeterRooms` uses on the wiki sub-map.
      const cf = s === "W" || s === "E" ? frac(t.row, fp.bbox.minR, fp.bbox.maxR) : frac(t.col, fp.bbox.minC, fp.bbox.maxC);
      const gate = gateRoomFor(s, cf);
      if (!gate) continue;
      // If the matched room is the shared OVERLAP boundary (it corresponds to the
      // marcopolo border-exit — a `nameHit`), enter the first interior room past it, not
      // the overlap tile itself (which is the overworld gate you just crossed from).
      const room = (nameHit(gate.name) && pastOverlap(gate)) || gate;
      if (!room) continue;
      const rk = `${room.r},${room.c}`;
      if (usedRoom.has(rk)) continue; // two road tiles onto the same gate → one gateway
      usedRoom.add(rk);
      out.push({
        col: t.col, row: t.row, target: gw.target, anchor: null,
        label: `${gw.label} (${sideName(s)} ${++i})`, entry: `${room.name}@${room.r},${room.c}`,
      });
    }
  }
  return out;
}

/** Build entrance gateways for one region grid map (async: reads wiki + marcopolo
 *  from `kbDir`). Returns the region's gateways UNCHANGED when it lacks the data
 *  (no marcopolo overworld or too few shared landmarks). */
export async function entranceGateways(grid: GridMap, kbDir: string): Promise<Gateway[]> {
  // Idempotent: an artifact enriched at crawl/bake time already carries the blocked
  // footprint + per-side entrance gateways, so a second pass (at index build) must
  // NOT re-inject off the injected gateways. Detect the side-labelled entrances.
  if (grid.gateways.some((g) => /\((Nord|Ost|Süd|West)rand \d+\)$/.test(g.label))) return grid.gateways;
  const regionSlug = lastSeg(grid.page);
  // marcopolo dirs/files are de-umlauted ("märchenland" → "maerchenland"); try the
  // slug as-is first, then its de-umlauted form.
  const mcDir = [regionSlug, deumlaut(regionSlug)].map((s) => path.join(kbDir, "_marcopolo", s, `${s}.md`));
  const mcOver = mcDir.find((p) => existsSync(p));
  if (!mcOver) return grid.gateways;
  const over = parseMcOkf(await readFile(mcOver, "utf8"), grid.region, regionSlug);
  // All marcopolo-overworld cross-links (used both as landmarks and, per sub-map,
  // as the entrance cluster).
  const mcCells = over.cellLinks.map((l) => ({ row: l.row, col: l.col, page: l.page }));
  const affine = fitAffine(landmarks(grid, mcCells));
  if (!affine) return grid.gateways;

  const out: Gateway[] = [];
  const supersede = new Set<string>(); // labels of original gateways we replace
  const processed = new Set<string>(); // targets handled (a city has several point gateways)
  for (const gw of grid.gateways) {
    if (!gw.target || gw.anchor) continue; // only whole-sub-map gateways
    const targetFile = path.join(kbDir, `${gw.target}.md`);
    if (!existsSync(targetFile)) continue;
    const wikiEnt = subMapEntrances(await readFile(targetFile, "utf8"), regionSlug);
    if (wikiEnt.length < 1) {
      // No region back-link edge rooms → not a forest. It may still be a CITY entered
      // by road (Lutetia): block its footprint and enter via the gif road crossings.
      // A city has several identical point gateways, so process the target once.
      if (!processed.has(gw.target)) {
        processed.add(gw.target);
        const city = await cityGateways(grid, kbDir, mcOver, regionSlug, gw);
        if (city.length) { out.push(...city); supersede.add(gw.label); }
      }
      continue;
    }
    // Identify the marcopolo overworld cluster for THIS sub-map. marcopolo is the
    // AUTHORITY for which/how-many entrances are real: the wiki often OVER-marks (the
    // village draws 8 `G` back-link cells but only 2 — mid-N + mid-S — are true
    // crossings, exactly what marcopolo lists). So a wrong sub-map is ruled out by (a)
    // marcopolo having an entrance side the wiki can't cover AND (b) affine proximity
    // of the two overworld clusters. Wiki EXCESS on a side is NOT penalised.
    const wSide = bySideWiki(wikiEnt);
    // Reference point for the affine proximity test = the sub-map's FOOTPRINT centre
    // (the whole area), not the single gateway POINT — the point sits at one imagemap
    // rect and can be several tiles off the area's centroid, which would fail a tight
    // gate. Falls back to the gateway point when there is no footprint.
    const fp = footprintOf(grid, gw.target);
    const [gcx, gcy] = fp
      ? [(fp.bbox.minC + fp.bbox.maxC) / 2, (fp.bbox.minR + fp.bbox.maxR) / 2]
      : [gw.col, gw.row];
    const subPages = [...new Set(mcCells.map((c) => normSlug(c.page)))].filter((p) => p !== regionSlug);
    let best: McEntrance[] | null = null, bestScore = Infinity;
    for (const pageBase of subPages) {
      const ent = penetrableEntrances(over, pageBase);
      if (!ent.length) continue;
      const m = bySide(ent);
      // Uncoverable = a marco entrance the wiki has no edge room for on that side.
      const uncoverable = (["N", "E", "S", "W"] as Side[]).reduce((s, k) => s + Math.max(0, m[k].length - wSide[k].length), 0);
      const cx = ent.reduce((s, e) => s + e.col, 0) / ent.length;
      const cy = ent.reduce((s, e) => s + e.row, 0) / ent.length;
      const [mx, my] = apply(affine, [cx, cy]);
      const score = uncoverable * 1000 + Math.hypot(mx - gcx, my - gcy);
      if (score < bestScore) { bestScore = score; best = ent; }
    }
    // Confident match only: the wiki must cover every marco entrance (uncoverable 0)
    // AND the two overworld clusters must land on nearly the same gif tile (a tight
    // affine proximity), which rejects a sub-map that has no real marcopolo counterpart.
    if (!best || bestScore >= 4) continue;
    // The sub-map's overworld FOOTPRINT comes straight from the gif's own imagemap
    // (the whole-region rects buildGridMap discards). Mark it impassable so the
    // router can't cut STRAIGHT THROUGH the forest/village — the gif paints it as
    // walkable grass, which is exactly why routes used to "enter" on an interior,
    // impenetrable tile. With the body blocked, the router must reach a real EDGE, and
    // each edge carries the matching wiki entrance. When the gif marks no footprint
    // (an ordinary point gateway), fall back to placing relative to the point.
    if (fp) {
      grid.blocked ??= Array.from({ length: grid.rows }, () => new Array<boolean>(grid.cols).fill(false));
      for (const k of fp.tiles) { const [r, c] = k.split(",").map(Number); grid.blocked[r][c] = true; }
    }
    // marcopolo supplies which SIDES carry penetrable entrances and how many; the
    // gif footprint supplies WHERE each side's edge is. An entrance on the west edge
    // sits just west of the forest, so the router approaching from the west (e.g.
    // the harbour) reaches it first and enters the matching `1 Rand` room.
    const mSide = bySide(best);
    let injected = 0;
    for (const s of ["N", "E", "S", "W"] as Side[]) {
      const ms = mSide[s];
      // marcopolo is authoritative for HOW MANY entrances this side really has; when
      // the wiki over-marks (more back-link rooms than real crossings), keep only the
      // marco-count many, centred along the side (so the village's mid-N/mid-S `G` win
      // over its corner `G` cells).
      const ws = pickCentered(wSide[s], ms.length);
      const n = ws.length; // == min(marco, wiki), only marco-confirmed penetrable
      for (let i = 0; i < n; i++) {
        // Geometric position from marcopolo (ms[i]); entry ROOM from the wiki (ws[i]).
        const tile = fp ? placeByAffine(grid, fp.bbox, affine, s, ms[i]) : placeOnSide(grid, gw.col, gw.row, s, i, n);
        if (!tile) continue;
        out.push({
          col: tile[0], row: tile[1], target: gw.target, anchor: null,
          label: `${gw.label} (${sideName(s)} ${i + 1})`,
          entry: `${ws[i].name}@${ws[i].r},${ws[i].c}`,
        });
        injected++;
      }
    }
    if (injected) supersede.add(gw.label);
  }
  // Drop the original single gateways we replaced with per-entrance ones.
  return [...grid.gateways.filter((g) => !supersede.has(g.label)), ...out];
}

const sideName = (s: Side) => ({ N: "Nordrand", E: "Ostrand", S: "Südrand", W: "Westrand" }[s]);

/** Position the i-th entrance (of `count`) on `side` of the forest, RELATIVE to the
 *  wiki forest gateway at (ax,ay): offset one small step off the anchor toward that
 *  side, and spread the entrances along the side's axis (W/E ordered N→S by row;
 *  N/S ordered W→E by col — matching subMapEntrances ordinals). Snapped to the
 *  nearest walkable tile. Absolute marco coords are deliberately NOT used — only the
 *  approach SIDE matters, and that is reliable across the two differently-drawn maps. */
function placeOnSide(grid: GridMap, ax: number, ay: number, side: Side, i: number, count: number): [number, number] | null {
  const D = 3, STEP = 2;
  const off = Math.round((i - (count - 1) / 2) * STEP);
  let c = ax, r = ay;
  if (side === "W") { c = ax - D; r = ay + off; }
  else if (side === "E") { c = ax + D; r = ay + off; }
  else if (side === "N") { r = ay - D; c = ax + off; }
  else { r = ay + D; c = ax + off; } // S
  return snap(grid, c, r);
}

/** Keep `n` items from `arr`, evenly spaced and centred (n=1 → the middle item),
 *  used when marcopolo says a side has fewer real entrances than the wiki marks. */
function pickCentered<T>(arr: T[], n: number): T[] {
  if (n >= arr.length) return arr;
  if (n <= 0) return [];
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.round(((i + 1) * arr.length) / (n + 1) - 0.5);
    out.push(arr[Math.min(arr.length - 1, Math.max(0, idx))]);
  }
  return out;
}

function bySideWiki(ent: SubMapEntrance[]) {
  const g: Record<Side, SubMapEntrance[]> = { N: [], E: [], S: [], W: [] };
  for (const e of ent) g[e.side].push(e);
  for (const s of Object.keys(g) as Side[]) g[s].sort((a, b) => a.ordinal - b.ordinal);
  return g;
}
