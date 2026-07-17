/**
 * Turn a decoded overworld gif + its imagemap rects into a `GridMap`:
 * a grid of 12×12 tiles classified by terrain, with per-tile traversal cost,
 * road directions, and the imagemap gateways snapped onto tiles.
 *
 * Grounded on decoded Asia.gif / Gallien2012.gif: tile pitch is a universal 12px
 * at native resolution; only the origin offset (0 or 1px) varies per map, and
 * the imagemap rect coordinates calibrate it (see MAP_PARSER_FINDINGS notes).
 */

import type { DecodedGif } from "./gifDecode.js";
import type { Dir, Gateway, GridMap, Terrain } from "./types.js";
import type { ImagemapRect } from "./imagemap.js";
import { slug } from "../../crawler/okf.js";

export const TILE = 12;

/** Group the whole-region imagemap rects (a sub-map's overworld footprint — the
 *  ones `buildGridMap` drops from gateways) by target page, as inclusive tile boxes.
 *  `rects` are in native pixels (already scaled). Point-ish rects (a city marker, ≤1
 *  tile) and anchor-only `#` rects (forest SCENERY, still walkable) are excluded — a
 *  footprint is a real, enterable-only ASCII sub-map area. */
export function subMapFootprints(
  rects: ImagemapRect[], cols: number, rows: number, origin: number, tile = TILE,
): { target: string; boxes: [number, number, number, number][] }[] {
  const by = new Map<string, [number, number, number, number][]>();
  const clampC = (c: number) => Math.min(cols - 1, Math.max(0, c));
  const clampR = (r: number) => Math.min(rows - 1, Math.max(0, r));
  for (const r of rects) {
    if (!r.target) continue; // '#' scenery (walkable forest terrain), not a sub-map
    if (r.x2 - r.x1 <= tile && r.y2 - r.y1 <= tile) continue; // point gateway (a city)
    const box: [number, number, number, number] = [
      clampC(Math.floor((r.x1 - origin) / tile)), clampR(Math.floor((r.y1 - origin) / tile)),
      clampC(Math.floor((r.x2 - origin) / tile)), clampR(Math.floor((r.y2 - origin) / tile)),
    ];
    (by.get(r.target) ?? by.set(r.target, []).get(r.target)!).push(box);
  }
  return [...by].map(([target, boxes]) => ({ target, boxes }));
}

/** All 8 directions with their (dRow, dCol) offsets. */
export const OFF: Record<Dir, [number, number]> = {
  E: [0, 1], W: [0, -1], N: [-1, 0], S: [1, 0],
  NE: [-1, 1], SW: [1, -1], NW: [-1, -1], SE: [1, 1],
};

/** Base traversal cost by terrain — roads are preferred (cheapest). Water/ocean
 *  are additionally subject to a consecutive-step drowning penalty in the router
 *  (a short crossing is fine; a long swim is deadly), so their base stays modest. */
const COST: Record<Terrain, number> = {
  road: 1, grass: 3, forest: 3, rock: 4, sand: 3, water: 5, ocean: 10, other: 3,
};

/** Classify a single palette color into a terrain family. */
function colorFamily([r, g, b]: [number, number, number]): Terrain {
  if (r < 40 && g < 40 && b < 40) return "ocean"; // near-black (also road strokes)
  if (b > 150 && r < 110) return "water";
  // Bright yellow/gold = coastal SAND/beach (walkable, but NOT a road) — the sea
  // border runs almost every map's edge, so treating it as a cheap road turned the
  // whole coastline into a preferred highway. Yellow has r≈g; brown dirt has r≫g.
  if (r > 180 && g > 140 && b < g - 40) return "sand";
  if (r > 90 && g > 30 && g < 150 && b < 70 && r > g + 40) return "road"; // brown dirt
  if (r > 150 && g > 150 && b > 150) return "rock"; // grey
  if (g > r && g > b) return g < 140 ? "forest" : "grass"; // dark forest vs bright grass green
  return "other";
}

/** Detect the tile-grid origin offset (0 or 1) from imagemap rect coords: most
 *  single-tile rects sit on the 12px pitch, so the modal `x1 mod 12` is the
 *  offset. Falls back to 0. */
export function detectOrigin(rects: ImagemapRect[]): number {
  const votes = new Map<number, number>();
  for (const r of rects) {
    if (r.x2 - r.x1 > TILE || r.y2 - r.y1 > TILE) continue; // multi-tile region rect
    for (const v of [r.x1 % TILE, r.y1 % TILE]) votes.set(v, (votes.get(v) ?? 0) + 1);
  }
  let best = 0, bestN = -1;
  for (const [v, n] of votes) if (n > bestN) { best = v; bestN = n; }
  return best <= 1 ? best : 0; // only 0/1 are plausible; anything else → 0
}

interface TileInfo { fam: Terrain; roadDirs: Dir[] }

/** Classify one tile from its pixels: dominant terrain family, plus a road-line
 *  test (a near-black/brown stroke crossing an otherwise-terrain tile) and the
 *  directions that stroke exits through. */
function classifyTile(gif: DecodedGif, ox: number, oy: number): TileInfo {
  const famCount = new Map<Terrain, number>();
  // Which of the 8 border bands carry stroke (near-black / brown) pixels.
  const strokeAt: boolean[][] = Array.from({ length: TILE }, () => new Array(TILE).fill(false));
  let stroke = 0;
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    const px = gif.pixels[(oy + y) * gif.width + (ox + x)];
    const rgb = gif.palette[px] ?? [0, 0, 0];
    const fam = colorFamily(rgb);
    famCount.set(fam, (famCount.get(fam) ?? 0) + 1);
    const [r, g, b] = rgb;
    // A road stroke is a near-black line or a dark-brown dirt path — NOT bright
    // sand yellow (r≈g), which would otherwise light up whole beaches as roads.
    const isStroke = (r < 60 && g < 60 && b < 60) || (r > 90 && g > 30 && g < 150 && b < 70 && r > g + 40);
    strokeAt[y][x] = isStroke;
    if (isStroke) stroke++;
  }
  const total = TILE * TILE;
  const oceanFrac = (famCount.get("ocean") ?? 0) / total;
  // A tile that is almost entirely black is open sea / void.
  if (oceanFrac > 0.85) return { fam: "ocean", roadDirs: [] };
  // Dominant non-ocean family = terrain.
  let fam: Terrain = "grass", best = -1;
  for (const [f, n] of famCount) { if (f === "ocean") continue; if (n > best) { best = n; fam = f; } }
  // Road-line test: a moderate stroke fraction over terrain (not a solid fill).
  const strokeFrac = stroke / total;
  const roadDirs = strokeFrac > 0.08 && strokeFrac < 0.75 ? strokeDirs(strokeAt) : [];
  if (roadDirs.length) fam = "road";
  return { fam, roadDirs };
}

/** Which of the 8 directions the stroke pixels touch the tile border in. */
function strokeDirs(strokeAt: boolean[][]): Dir[] {
  const n = TILE, e = n - 1, band = 3; // corner band width
  const hit = { N: false, S: false, E: false, W: false, NE: false, NW: false, SE: false, SW: false };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (!strokeAt[y][x]) continue;
    const top = y < band, bot = y >= n - band, left = x < band, right = x >= n - band;
    if (top && left) hit.NW = true; else if (top && right) hit.NE = true;
    else if (bot && left) hit.SW = true; else if (bot && right) hit.SE = true;
    else if (top) hit.N = true; else if (bot) hit.S = true;
    else if (left) hit.W = true; else if (right) hit.E = true;
  }
  return (Object.keys(hit) as Dir[]).filter((d) => hit[d]);
}

/** Build the full GridMap from a decoded gif + its imagemap rects.
 *  `displayWidth` is the px width the imagemap coords were authored against; when
 *  it differs from the gif's native width the rects are scaled so they line up
 *  with the native-pixel tile grid. */
export function buildGridMap(
  region: string, gif: DecodedGif, rawRects: ImagemapRect[], displayWidth: number | null = null,
): GridMap {
  const scale = displayWidth && displayWidth !== gif.width ? gif.width / displayWidth : 1;
  const rects = scale === 1 ? rawRects : rawRects.map((r) => ({
    ...r,
    x1: Math.round(r.x1 * scale), y1: Math.round(r.y1 * scale),
    x2: Math.round(r.x2 * scale), y2: Math.round(r.y2 * scale),
  }));
  const origin = detectOrigin(rects);
  const cols = Math.floor((gif.width - origin) / TILE);
  const rows = Math.floor((gif.height - origin) / TILE);
  const tiles: Terrain[][] = [];
  const cost: number[][] = [];
  const roadDirs: Dir[][][] = [];
  for (let tr = 0; tr < rows; tr++) {
    const tRow: Terrain[] = [], cRow: number[] = [], dRow: Dir[][] = [];
    for (let tc = 0; tc < cols; tc++) {
      const info = classifyTile(gif, origin + tc * TILE, origin + tr * TILE);
      tRow.push(info.fam); cRow.push(COST[info.fam]); dRow.push(info.roadDirs);
    }
    tiles.push(tRow); cost.push(cRow); roadDirs.push(dRow);
  }
  const gateways: Gateway[] = rects
    .filter((r) => r.x2 - r.x1 <= TILE * 3 && r.y2 - r.y1 <= TILE * 3) // point-ish, not a whole region
    .map((r) => {
      const cx = (r.x1 + r.x2) / 2, cy = (r.y1 + r.y2) / 2;
      return {
        col: Math.min(cols - 1, Math.max(0, Math.floor((cx - origin) / TILE))),
        row: Math.min(rows - 1, Math.max(0, Math.floor((cy - origin) / TILE))),
        target: r.target,
        anchor: r.anchor,
        label: r.label,
      };
    });
  // Namespace grid pages under `karte/` so a region's raster overworld never
  // collides with its ASCII map page (e.g. drachenland.md's Burg Tregyln).
  const subMaps = subMapFootprints(rects, cols, rows, origin);
  return {
    region, page: `karte/${slug(region)}`, cols, rows, tileSize: TILE, origin, tiles, cost, roadDirs, gateways,
    ...(subMaps.length ? { subMaps } : {}),
  };
}
