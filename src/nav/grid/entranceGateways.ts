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
import { subMapEntrances, deumlaut, type SubMapEntrance } from "../mapGraph.js";
import { parseMcOkf } from "../marcopolo/okf.js";
import { penetrableEntrances, bySide, type McEntrance, type Side } from "../marcopolo/entrances.js";
interface Bbox { minC: number; maxC: number; minR: number; maxR: number; }

/** The overworld footprint of a sub-map, read from the BAKED `grid.subMaps` (the
 *  imagemap wikitext is not shipped in the KB tarball, so the footprint must travel
 *  inside the grid artifact). Expands the tile boxes into a tile set + bounding box —
 *  the blocked ASCII-map body the gif paints as walkable grass. Returns null when the
 *  sub-map has no footprint (an ordinary point gateway — a city — has nothing to
 *  block). */
function footprintOf(grid: GridMap, targetSlug: string): { tiles: Set<string>; bbox: Bbox } | null {
  const sm = grid.subMaps?.find((s) => normSlug(s.target) === targetSlug);
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

/** Place an entrance just OUTSIDE the gif footprint on `side`, at the FRACTIONAL
 *  position the wiki sub-map records for it. The wiki ascii sub-map is the
 *  authoritative schematic for WHERE along an edge each entrance sits: take the
 *  entrance room's position as a fraction of the whole sub-map's extent along the
 *  edge axis (W/E → row within [mapR0,mapR1]; N/S → col within [mapC0,mapC1]) and
 *  re-project it onto the gif footprint's edge span, then step one tile off the
 *  footprint on `side`. This keeps entrances off the footprint CORNERS (a corner is
 *  never a straight crossing) and needs no marco↔gif coordinate alignment, which does
 *  not hold. marcopolo supplies which sides are penetrable + the straight direction;
 *  the wiki supplies the along-edge position. Snapped to a walkable, non-footprint tile. */
function placeByWikiFrac(grid: GridMap, fp: Bbox, side: Side, e: SubMapEntrance): [number, number] | null {
  const frac = (v: number, lo: number, hi: number) => (hi <= lo ? 0.5 : (v - lo) / (hi - lo));
  let c: number, r: number;
  if (side === "W" || side === "E") {
    const f = frac(e.r, e.mapR0, e.mapR1);
    r = Math.round(fp.minR + f * (fp.maxR - fp.minR));
    c = side === "W" ? fp.minC - 1 : fp.maxC + 1;
  } else {
    const f = frac(e.c, e.mapC0, e.mapC1);
    c = Math.round(fp.minC + f * (fp.maxC - fp.minC));
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
  for (const gw of grid.gateways) {
    if (!gw.target || gw.anchor) continue; // only whole-sub-map gateways
    const targetFile = path.join(kbDir, `${gw.target}.md`);
    if (!existsSync(targetFile)) continue;
    const wikiEnt = subMapEntrances(await readFile(targetFile, "utf8"), regionSlug);
    if (wikiEnt.length < 1) continue; // needs at least one region-linked edge room
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
    const fp = footprintOf(grid, normSlug(gw.target));
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
        const tile = fp ? placeByWikiFrac(grid, fp.bbox, s, ws[i]) : placeOnSide(grid, gw.col, gw.row, s, i, n);
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
