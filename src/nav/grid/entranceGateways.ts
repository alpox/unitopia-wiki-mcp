/**
 * Synthesize overworld→sub-map ENTRANCE gateways for a raster (gif) region.
 *
 * Each source decides what it is good at:
 *   - wiki gif: terrain, cost and absolute geometry; which page an area belongs to;
 *   - wiki sub-map: the room you enter (its edge rooms, matched by side + ordinal);
 *   - marcopolo overworld, registered tile-by-tile onto the gif (`mcRegister.ts`):
 *     the solid BODY of a sub-map (its blank hole — the painted area around it can be
 *     ordinary walkable forest), which entrances exist and where, and the exact moves
 *     at a gateway tile.
 * marcopolo only ever removes walkability the gif offers. A region without a
 * registrable marcopolo overworld keeps its gateways unchanged. See
 * [[overworld-ascii-entrance-seam]].
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { GridMap, Gateway } from "./types.js";
import { subMapEntrances, perimeterRooms, stepFrom, deumlaut, type SubMapEntrance, type PerimeterRoom } from "../mapGraph.js";
import { parseMcOkf } from "../marcopolo/okf.js";
import { penetrableEntrances, bySide, borderGateTokens, landBorderLabels, overworldGateDirs, cellBlockedDirs, type McEntrance, type Side } from "../marcopolo/entrances.js";
import type { McMap } from "../marcopolo/extract.js";
import { overworldLayer, type McTileLayer } from "../marcopolo/overworldLayer.js";
import { registerLayer, apply, normSlug, type Registration } from "./mcRegister.js";
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

const lastSeg = (p: string) => p.split("/").pop()!;

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
async function cityGateways(grid: GridMap, kbDir: string, over: McMap, mcOver: string, regionSlug: string, gw: Gateway, hole?: Set<string>): Promise<Gateway[]> {
  if (!gw.target) return [];
  const fp = footprintOf(grid, gw.target);
  if (!fp) return [];
  const crossings = roadCrossings(grid, fp);
  if (!crossings.length) return [];
  const crossingTiles = new Set(crossings.map((x) => `${x.row},${x.col}`));
  for (const k of hole ?? []) if (!crossingTiles.has(k)) fp.tiles.add(k);
  const subFile = path.join(path.dirname(mcOver), `${lastSeg(gw.target)}.md`);
  if (!existsSync(subFile)) return [];
  const sub = parseMcOkf(await readFile(subFile, "utf8"), grid.region, lastSeg(gw.target));
  // marcopolo confirms a real land gate exists (a border-exit that links back to the
  // region and is not water); its name tokens are kept only as a tiebreak.
  const region = lastSeg(mcOver).replace(/\.md$/, "");
  const tokens = borderGateTokens(sub, region);
  if (!tokens.length) return [];
  // marcopolo's EXACT edges at each overworld gate cell → the moves not walkable from it
  // (Lutetia's east Stadttor draws no NE connector → "nordosten" blocked). Applied to the
  // matching gif gateway tile by SIDE, so the router can't leave a gate in a direction the
  // road doesn't go (no cross-grid alignment: a compass direction maps 1:1).
  const gateDirs = overworldGateDirs(over, landBorderLabels(sub, region), lastSeg(gw.target));
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
      const gd = gateDirs.find((d) => d.side === s);
      out.push({
        col: t.col, row: t.row, target: gw.target, anchor: null,
        label: `${gw.label} (${sideName(s)} ${++i})`, entry: `${room.name}@${room.r},${room.c}`,
        ...(gd?.blockedDirs.length ? { blockedDirs: gd.blockedDirs } : {}),
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
  const layer = overworldLayer(over);
  const reg = registerLayer(grid, layer, over);
  if (!reg) return grid.gateways;
  const affine = reg.affine;
  const mcCells = over.cellLinks.map((l) => ({ row: l.row, col: l.col, page: l.page }));
  // Tiles that stay walkable inside any body: gateway tiles of other targets (Lutetia's
  // footprint covers the "Hafen Lutetia" harbour).
  const keepFor = (target: string) => new Set(grid.gateways.filter((g) => g.target && g.target !== target).map((g) => `${g.row},${g.col}`));
  const block = (tiles: Iterable<string>, target: string) => {
    const keep = keepFor(target);
    grid.blocked ??= Array.from({ length: grid.rows }, () => new Array<boolean>(grid.cols).fill(false));
    for (const k of tiles) { if (keep.has(k)) continue; const [r, c] = k.split(",").map(Number); if (grid.blocked[r]) grid.blocked[r][c] = true; }
  };

  const out: Gateway[] = [];
  const supersede = new Set<string>(); // labels of original gateways we replace
  const processed = new Set<string>(); // targets handled (a city has several point gateways)
  for (const gw of grid.gateways) {
    if (!gw.target || gw.anchor) continue; // only whole-sub-map gateways
    const targetFile = path.join(kbDir, `${gw.target}.md`);
    if (!existsSync(targetFile)) continue;
    const wikiMd = await readFile(targetFile, "utf8");
    const wikiEnt = subMapEntrances(wikiMd, regionSlug);
    if (wikiEnt.length < 1) {
      // No region back-link edge rooms → not a forest. It may still be a CITY entered
      // by road (Lutetia): block its footprint and enter via the gif road crossings.
      // A city has several identical point gateways, so process the target once.
      if (!processed.has(gw.target)) {
        processed.add(gw.target);
        const city = await cityGateways(grid, kbDir, over, mcOver, regionSlug, gw, holeBody(layer, reg, lastSeg(gw.target))?.tiles);
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
    // The solid body is marcopolo's hole for this sub-map, registered onto the gif —
    // not the imagemap rect or the painted area, which also cover walkable forest.
    // Its entrances are the rim portals at their registered tiles. Without a hole
    // nothing is blocked and entrances go to their affine position.
    const body = holeBody(layer, reg, best[0].page);
    if (body) block(body.tiles, gw.target);
    const placeEntrance = (e: McEntrance): [number, number] | null => {
      const t = body ? body.proj(...layer.tileOf(e.row, e.col)) : apply(affine, [e.col, e.row]);
      const [c, r] = [Math.round(t[0]), Math.round(t[1])];
      return grid.blocked?.[r]?.[c] ? snapFree(grid, c, r) : snap(grid, c, r);
    };
    // The wiki edge room links back to the region: it IS the overworld tile the
    // gateway stands on (the shared overlap, like Lutetia's Stadttor), so the route
    // enters the room one step past it (gallierwald `1 Rand` → the first `o`).
    const step = stepFrom(wikiMd);
    const INWARD: Record<Side, string> = { N: "S", S: "N", W: "E", E: "W" };
    const entryPast = (e: SubMapEntrance, s: Side) => {
      const p = step(e.group, e.r, e.c, INWARD[s]);
      return p ? `${p.name ?? e.name}@${p.r},${p.c}` : `${e.name}@${e.r},${e.c}`;
    };
    // marcopolo supplies which SIDES carry penetrable entrances, how many, and where.
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
        const tile = placeEntrance(ms[i]);
        if (!tile) continue;
        out.push({
          col: tile[0], row: tile[1], target: gw.target, anchor: null,
          label: `${gw.label} (${sideName(s)} ${i + 1})`,
          entry: entryPast(ws[i], s),
        });
        injected++;
      }
    }
    if (injected) supersede.add(gw.label);
  }
  const result = [...grid.gateways.filter((g) => !supersede.has(g.label)), ...out];
  applyMarcoEdges(grid, over, layer, reg, result);
  return result;
}

/** marcopolo's hole for sub-map `page`, projected onto gif tiles as one rigid piece
 *  ("r,c" keys) plus the projection it used, or null without a registered hole. */
function holeBody(layer: McTileLayer, reg: Registration, page: string): { tiles: Set<string>; proj: (tr: number, tc: number) => [number, number] } | null {
  const hole = layer.holes.find((h) => h.pages[0] === page);
  if (!hole) return null;
  const proj = reg.rigid([...hole.tiles, ...hole.portals.map((p): [number, number] => [p.tr, p.tc])]);
  if (!proj) return null;
  return { tiles: new Set(hole.tiles.map(([tr, tc]) => { const [c, r] = proj(tr, tc); return `${r},${c}`; })), proj };
}

/** A letter that occurs at most this often (per colour) on the overworld marks a place,
 *  not terrain (Mixnix's cyan `M`, not the sea's `M`). */
const RARE = 6;

/** marcopolo's exact edges at a gateway/POI tile: the marcopolo cell registered on (or
 *  right next to) the tile — a rare letter, i.e. a place — gives the moves the map
 *  draws; the others are blocked (Mixnix's `M` connects only east). Skipped where the
 *  tile is unregistered, the restriction is all-or-nothing, or no open move reaches a
 *  walkable tile. City gates already carry theirs from `overworldGateDirs`. */
function applyMarcoEdges(grid: GridMap, over: McMap, layer: McTileLayer, reg: Registration, gateways: Gateway[]): void {
  const lines = over.ascii.split("\n");
  const color = new Map(over.cellColors.map((c) => [`${c.row},${c.col}`, c.color]));
  const kind = (tr: number, tc: number) => {
    const [r, c] = layer.charOf(tr, tc);
    return `${layer.letter(tr, tc)}${color.get(`${r},${c}`) ?? ""}`;
  };
  const freq = new Map<string, number>();
  const onGif = new Map<string, [number, number]>();
  for (let tr = 0; tr < layer.rows; tr++) for (let tc = 0; tc < layer.cols; tc++) {
    if (!layer.letter(tr, tc)) continue;
    freq.set(kind(tr, tc), (freq.get(kind(tr, tc)) ?? 0) + 1);
    const g = reg.toGif(tr, tc);
    if (g) onGif.set(`${g[0]},${g[1]}`, [tr, tc]);
  }
  const walkable = (c: number, r: number) => r >= 0 && c >= 0 && r < grid.rows && c < grid.cols && grid.tiles[r][c] !== "ocean" && !grid.blocked?.[r]?.[c];
  const OFF: Record<string, [number, number]> = {
    norden: [-1, 0], sueden: [1, 0], osten: [0, 1], westen: [0, -1],
    nordosten: [-1, 1], nordwesten: [-1, -1], suedosten: [1, 1], suedwesten: [1, -1],
  };
  for (const g of gateways) {
    if (g.blockedDirs?.length) continue;
    let cell: [number, number] | null = null, bestD = Infinity;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const m = onGif.get(`${g.col + dc},${g.row + dr}`);
      if (!m || (freq.get(kind(...m)) ?? 0) > RARE) continue;
      const d = Math.abs(dr) + Math.abs(dc);
      if (d < bestD) { bestD = d; cell = m; }
    }
    if (!cell) continue;
    const blocked = cellBlockedDirs(lines, ...layer.charOf(...cell));
    if (!blocked || blocked.length < 1 || blocked.length > 7) continue;
    const open = Object.keys(OFF).filter((d) => !blocked.includes(d));
    if (!open.some((d) => walkable(g.col + OFF[d][1], g.row + OFF[d][0]))) continue;
    g.blockedDirs = blocked;
  }
}

const sideName = (s: Side) => ({ N: "Nordrand", E: "Ostrand", S: "Südrand", W: "Westrand" }[s]);

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
