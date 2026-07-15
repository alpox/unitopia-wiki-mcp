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
import { subMapEntrances, deumlaut } from "../mapGraph.js";
import { parseMcOkf } from "../marcopolo/okf.js";
import { penetrableEntrances, bySide, type McEntrance, type Side } from "../marcopolo/entrances.js";

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
 *  tile the grid router can actually stand on. */
function snap(grid: GridMap, col: number, row: number, maxR = 4): [number, number] | null {
  const ok = (c: number, r: number) =>
    r >= 0 && r < grid.rows && c >= 0 && c < grid.cols && grid.tiles[r]?.[c] !== "ocean";
  const c0 = Math.round(col), r0 = Math.round(row);
  for (let rad = 0; rad <= maxR; rad++)
    for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++)
      if (Math.max(Math.abs(dr), Math.abs(dc)) === rad && ok(c0 + dc, r0 + dr)) return [c0 + dc, r0 + dr];
  return null;
}

/** Build entrance gateways for one region grid map (async: reads wiki + marcopolo
 *  from `kbDir`). Returns the region's gateways UNCHANGED when it lacks the data
 *  (no marcopolo overworld or too few shared landmarks). */
export async function entranceGateways(grid: GridMap, kbDir: string): Promise<Gateway[]> {
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
    if (wikiEnt.length < 2) continue; // needs a real edge-room set to distribute
    // Identify the marcopolo overworld cluster for THIS sub-map by ENTRANCE-COUNT
    // PROFILE: the wiki sub-map and its true marcopolo counterpart mark the same
    // real entrances, so their per-side counts agree. Proximity alone fails —
    // nearby single-tile clusters (a Römerlager) can map closer than the wald's
    // own centroid. Score = side-count mismatch first, affine distance as tiebreak.
    const wSide = bySideWiki(wikiEnt);
    const [gcx, gcy] = [gw.col, gw.row];
    const subPages = [...new Set(mcCells.map((c) => normSlug(c.page)))].filter((p) => p !== regionSlug);
    let best: McEntrance[] | null = null, bestScore = Infinity;
    for (const pageBase of subPages) {
      const ent = penetrableEntrances(over, pageBase);
      if (!ent.length) continue;
      const m = bySide(ent);
      const mismatch = (["N", "E", "S", "W"] as Side[]).reduce((s, k) => s + Math.abs(wSide[k].length - m[k].length), 0);
      const cx = ent.reduce((s, e) => s + e.col, 0) / ent.length;
      const cy = ent.reduce((s, e) => s + e.row, 0) / ent.length;
      const [mx, my] = apply(affine, [cx, cy]);
      const score = mismatch * 1000 + Math.hypot(mx - gcx, my - gcy);
      if (score < bestScore) { bestScore = score; best = ent; }
    }
    // Only inject on a confident profile match (allow ±2 total for river/corner
    // noise); otherwise leave the original single gateway untouched.
    if (!best || bestScore >= 3000) continue;
    // Match wiki edge rooms to marcopolo cells by (side, ordinal) and inject.
    const mSide = bySide(best);
    let injected = 0;
    for (const s of ["N", "E", "S", "W"] as Side[]) {
      const ws = wSide[s], ms = mSide[s];
      for (let i = 0; i < Math.min(ws.length, ms.length); i++) {
        const [c, r] = apply(affine, [ms[i].col, ms[i].row]);
        const tile = snap(grid, c, r);
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

function bySideWiki(ent: { side: Side; ordinal: number; name: string | null; r: number; c: number }[]) {
  const g: Record<Side, typeof ent> = { N: [], E: [], S: [], W: [] };
  for (const e of ent) g[e.side].push(e);
  for (const s of Object.keys(g) as Side[]) g[s].sort((a, b) => a.ordinal - b.ordinal);
  return g;
}
