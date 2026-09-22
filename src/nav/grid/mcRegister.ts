/**
 * Register a marcopolo overworld tile layer onto a wiki gif grid.
 *
 * A landmark affine (gif gateways ↔ marcopolo cells linking the same page) gives the
 * rough mapping; one marcopolo tile ≈ one gif tile. The wiki gif is newer and not
 * drawn identically, so each window of the map then gets its own integer offset
 * (±2 tiles): the one under which marcopolo's letters best agree with the gif terrain
 * (`M`→water, `O`→grass, `W`→forest, …; the letter→terrain table is learned from the
 * map itself). Where no offset agrees well the tile stays unregistered and marcopolo
 * is not applied there.
 */
import type { GridMap, Terrain } from "./types.js";
import type { McMap } from "../marcopolo/extract.js";
import type { McTileLayer } from "../marcopolo/overworldLayer.js";
import { deumlaut } from "../mapGraph.js";

export interface Affine { ax: number; bx: number; ay: number; by: number; }
type Pair = { from: [number, number]; to: [number, number] };

/** A separable least-squares affine fit p → (a·p+b) on each axis independently
 *  (the gif and marcopolo grids differ only in scale + offset, no rotation). */
export function fitAffine(pairs: Pair[]): Affine | null {
  if (pairs.length < 3) return null;
  const fit1 = (get: (p: Pair) => [number, number]) => {
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
export const apply = (a: Affine, [x, y]: [number, number]): [number, number] => [a.ax * x + a.bx, a.ay * y + a.by];

const lastSeg = (p: string) => p.split("/").pop()!;
/** Page slug comparable across wiki and marcopolo (`dörrstadt` ~ `doerrstadt`). */
export const normSlug = (s: string) => deumlaut(lastSeg(s).replace(/\.md$/, "").replace(/^kompass-/, ""));

/** Landmark pairs: gif gateways and marcopolo-overworld cells that reference the
 *  same target page (by normalized slug), giving (marco char col,row → gif col,row). */
export function landmarks(grid: GridMap, mcCells: { row: number; col: number; page: string }[]): Pair[] {
  const gifBy = new Map<string, [number, number]>();
  for (const g of grid.gateways) if (g.target) gifBy.set(normSlug(g.target), [g.col, g.row]);
  const pairs: Pair[] = [];
  const seen = new Set<string>();
  for (const c of mcCells) {
    const k = normSlug(c.page);
    const gif = gifBy.get(k);
    if (gif && !seen.has(k)) { seen.add(k); pairs.push({ from: [c.col, c.row], to: gif }); }
  }
  return pairs;
}

export interface Registration {
  affine: Affine;
  /** Letter→terrain agreement of the best global offset (0..1). */
  score: number;
  /** gif (col,row) of marco tile (tr,tc), or null where the tile is unregistered. */
  toGif(tr: number, tc: number): [number, number] | null;
  /** Local agreement (0..1) at marco tile (tr,tc). */
  conf(tr: number, tc: number): number;
  /** Project a group of tiles (a hole and its rim) with ONE offset — the most
   *  confident one among them — so it lands as a single piece, without seams
   *  between windows. null when none of them is registered. */
  rigid(tiles: [number, number][]): ((tr: number, tc: number) => [number, number]) | null;
}

const WIN = 16, STRIDE = 8, SHIFT = 2, MIN_LETTERS = 12;

export function registerLayer(grid: GridMap, layer: McTileLayer, over: McMap, minConf = 0.7): Registration | null {
  const affine = fitAffine(landmarks(grid, over.cellLinks));
  if (!affine) return null;
  const base = (tr: number, tc: number): [number, number] => {
    const [r, c] = layer.charOf(tr, tc);
    const [x, y] = apply(affine, [c, r]);
    return [Math.round(x), Math.round(y)];
  };
  const terrain = (c: number, r: number): Terrain | undefined => grid.tiles[r]?.[c];
  const lettered: { tr: number; tc: number; l: string; b: [number, number] }[] = [];
  for (let tr = 0; tr < layer.rows; tr++) for (let tc = 0; tc < layer.cols; tc++) {
    const l = layer.letter(tr, tc);
    if (l) lettered.push({ tr, tc, l, b: base(tr, tc) });
  }
  if (!lettered.length) return null;

  // Global offset + the letter→terrain table it implies.
  const table = (dx: number, dy: number, set = lettered) => {
    const t = new Map<string, Map<string, number>>();
    for (const x of set) {
      const ter = terrain(x.b[0] + dx, x.b[1] + dy);
      if (!ter) continue;
      const m = t.get(x.l) ?? t.set(x.l, new Map()).get(x.l)!;
      m.set(ter, (m.get(ter) ?? 0) + 1);
    }
    return t;
  };
  let best = { dx: 0, dy: 0, agree: -1, lt: new Map<string, string>() };
  for (let dx = -SHIFT; dx <= SHIFT; dx++) for (let dy = -SHIFT; dy <= SHIFT; dy++) {
    const t = table(dx, dy);
    let hit = 0, n = 0;
    const lt = new Map<string, string>();
    for (const [l, m] of t) {
      let top = "", tn = 0;
      for (const [ter, k] of m) { n += k; if (k > tn) { tn = k; top = ter; } }
      hit += tn; lt.set(l, top);
    }
    const agree = n ? hit / n : 0;
    if (agree > best.agree) best = { dx, dy, agree, lt };
  }
  const lt = best.lt;
  const agreeAt = (set: typeof lettered, dx: number, dy: number) => {
    let hit = 0;
    for (const x of set) if (terrain(x.b[0] + dx, x.b[1] + dy) === lt.get(x.l)) hit++;
    return set.length ? hit / set.length : 0;
  };

  // Per-window offset: each tile takes the best-agreeing window covering it.
  const off = new Map<string, { dx: number; dy: number; conf: number }>();
  for (let wr = 0; wr < layer.rows; wr += STRIDE) for (let wc = 0; wc < layer.cols; wc += STRIDE) {
    const set = lettered.filter((x) => x.tr >= wr && x.tr < wr + WIN && x.tc >= wc && x.tc < wc + WIN);
    if (set.length < MIN_LETTERS) continue;
    let w = { dx: best.dx, dy: best.dy, conf: agreeAt(set, best.dx, best.dy) };
    for (let dx = -SHIFT; dx <= SHIFT; dx++) for (let dy = -SHIFT; dy <= SHIFT; dy++) {
      const a = agreeAt(set, dx, dy);
      // Prefer the global offset unless another one is clearly better.
      if (a > w.conf + 0.05) w = { dx, dy, conf: a };
    }
    for (let tr = wr; tr < Math.min(layer.rows, wr + WIN); tr++) for (let tc = wc; tc < Math.min(layer.cols, wc + WIN); tc++) {
      const k = `${tr},${tc}`, cur = off.get(k);
      if (!cur || w.conf > cur.conf) off.set(k, w);
    }
  }
  return {
    affine,
    score: best.agree,
    conf: (tr, tc) => off.get(`${tr},${tc}`)?.conf ?? 0,
    toGif: (tr, tc) => {
      const o = off.get(`${tr},${tc}`);
      if (!o || o.conf < minConf) return null;
      const [x, y] = base(tr, tc);
      return [x + o.dx, y + o.dy];
    },
    rigid: (tiles) => {
      let o: { dx: number; dy: number; conf: number } | undefined, at: [number, number] | undefined;
      for (const t of tiles) { const w = off.get(`${t[0]},${t[1]}`); if (w && (!o || w.conf > o.conf)) { o = w; at = t; } }
      if (!o || !at || o.conf < minConf) return null;
      // One tile per tile from the anchor: rounding the ~1.01 scale must not skip a row.
      const [ax0, ay0] = base(at[0], at[1]);
      const gx = ax0 + o.dx, gy = ay0 + o.dy;
      return (tr, tc) => [gx + (tc - at![1]), gy + (tr - at![0])];
    },
  };
}
