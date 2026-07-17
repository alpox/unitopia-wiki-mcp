/**
 * Grid (raster overworld) pipeline tests. Run with `npm test`.
 *
 * The unit tests are self-contained (synthetic grids / wikitext). The final
 * integration test exercises the real Asia artifact IF it has been built
 * (`npm run crawl:gridmaps`); it is skipped otherwise so CI without the artifact
 * still passes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { routeOnGrid, resolveTile, renderGridAscii } from "./grid/gridRouter.js";
import { detectOrigin } from "./grid/tileGrid.js";
import { parseImagemaps, parseLink } from "./grid/imagemap.js";
import { entranceGateways } from "./grid/entranceGateways.js";
import { loadNavIndex, buildNavInMemory } from "./navIndex.js";
import { config } from "../config.js";
import type { GridMap, Terrain, Dir } from "./grid/types.js";

const COST: Record<Terrain, number> = { road: 1, grass: 3, forest: 3, rock: 4, sand: 4, water: 6, ocean: 12, other: 3 };
const GLYPH: Record<string, Terrain> = { ".": "grass", "=": "road", " ": "ocean", "~": "water", "^": "rock", ",": "forest" };

/** Build a GridMap from ASCII rows (one char = one tile). */
function mk(rows: string[], gateways: GridMap["gateways"] = []): GridMap {
  const tiles = rows.map((r) => [...r].map((c) => GLYPH[c] ?? "grass"));
  const cost = tiles.map((row) => row.map((t) => COST[t]));
  const roadDirs: Dir[][][] = tiles.map((row) => row.map(() => []));
  return {
    region: "Test", page: "test", cols: rows[0].length, rows: rows.length,
    tileSize: 12, origin: 0, tiles, cost, roadDirs, gateways,
  };
}

test("parseLink: page, anchor and category forms", () => {
  assert.deepEqual(parseLink("Foo-Ling-Yoo"), { target: "foo-ling-yoo", anchor: null, label: "Foo-Ling-Yoo" });
  assert.deepEqual(parseLink("Nankea#Karte|Kathedrale"), { target: "nankea", anchor: "Karte", label: "Kathedrale" });
  assert.deepEqual(parseLink("#Weltenrand|Rand"), { target: null, anchor: "Weltenrand", label: "Rand" });
  assert.deepEqual(parseLink(":Kategorie:Gallien|Gallien"), { target: "kategorie/gallien", anchor: null, label: "Gallien" });
});

test("detectOrigin: reads the 12px offset from single-tile rects", () => {
  // Gallien-style coords are all ≡1 (mod 12) → origin 1.
  const rects = [349, 697, 121].map((x) => ({ x1: x, y1: x, x2: x + 11, y2: x + 11, target: null, anchor: null, label: "" }));
  assert.equal(detectOrigin(rects), 1);
  // Asia-style native coords are multiples of 12 → origin 0.
  const rects0 = [96, 108, 120].map((x) => ({ x1: x, y1: x, x2: x + 11, y2: x + 11, target: null, anchor: null, label: "" }));
  assert.equal(detectOrigin(rects0), 0);
});

test("parseImagemaps: extracts region blocks with image + rects", () => {
  const wt = `{{#ifeq: {{{1}}} | Asia | <imagemap>
Image:Asia.gif|Asia
rect  96 204 107 215 [[Foo-Ling-Yoo]]
rect 168 156 179 167 [[#Nurikomoon-Tempel|Nurikomoon-Tempel]]
desc none
</imagemap> |  }}`;
  const blocks = parseImagemaps(wt);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].region, "Asia");
  assert.equal(blocks[0].image, "Asia.gif");
  assert.equal(blocks[0].rects.length, 2);
  assert.equal(blocks[0].rects[0].target, "foo-ling-yoo");
});

const DIR: Record<string, [number, number]> = {
  osten: [0, 1], westen: [0, -1], norden: [-1, 0], sueden: [1, 0],
  nordosten: [-1, 1], suedwesten: [1, -1], nordwesten: [-1, -1], suedosten: [1, 1],
};
/** Walk a route's compass steps from its start tile → the visited tile coords. */
function visited(g: GridMap, start: string, r: { steps?: { dir: string | null }[] }): [number, number][] {
  const s = resolveTile(g, start)!;
  let c = s.col, row = s.row;
  const out: [number, number][] = [[c, row]];
  for (const st of r.steps ?? []) { const [dr, dc] = DIR[st.dir!]; row += dr; c += dc; out.push([c, row]); }
  return out;
}

test("routeOnGrid: prefers the road over the costlier grass line", () => {
  //  row0 all grass, row1 all road → the cheapest path hugs the road.
  const g = mk([".....", "=====", "....."]);
  const r = routeOnGrid(g, "0,0", "4,0");
  assert.ok(r.ok, r.error);
  const onRoad = visited(g, "0,0", r).some(([c, row]) => g.tiles[row][c] === "road");
  assert.ok(onRoad, "the route should travel along the cheaper road tiles");
});

test("routeOnGrid: prefers a short land detour over a costly ocean tile", () => {
  // (0,1) is ocean; a one-tile diagonal detour via the grass at (1,1) is cheaper.
  const g = mk(["..", " .", ".."]);
  const r = routeOnGrid(g, "0,0", "0,2");
  assert.ok(r.ok, r.error);
  const crossedOcean = visited(g, "0,0", r).some(([c, row]) => g.tiles[row][c] === "ocean");
  assert.ok(!crossedOcean, "the route should skirt costly ocean when a cheap land detour exists");
});

/** Longest run of consecutive water/ocean tiles along a visited path. */
function maxWaterRun(g: GridMap, path: [number, number][]): number {
  let run = 0, max = 0;
  for (const [c, r] of path) {
    const wet = g.tiles[r][c] === "water" || g.tiles[r][c] === "ocean";
    run = wet ? run + 1 : 0;
    max = Math.max(max, run);
  }
  return max;
}

test("routeOnGrid: a forced short water crossing (3 tiles) is allowed, not blocked", () => {
  // A 3-wide water band spanning the only row → the crossing is unavoidable and
  // within the safe limit, so it must still route.
  const g = mk(["..~~~.."]);
  const r = routeOnGrid(g, "0,0", "6,0");
  assert.ok(r.ok, r.error);
  assert.equal(maxWaterRun(g, visited(g, "0,0", r)), 3, "crosses exactly the 3 water tiles");
});

test("routeOnGrid: a long swim is deadly — the route takes the land detour", () => {
  //  Straight across row0 is 4 consecutive water tiles (deadly); row1 is land.
  const g = mk([".~~~~.", "......"]);
  const r = routeOnGrid(g, "0,0", "5,0");
  assert.ok(r.ok, r.error);
  assert.ok(maxWaterRun(g, visited(g, "0,0", r)) <= 3, "must not attempt a >3-tile swim");
});

test("routeOnGrid: resolves gateways by label and emits compass dirs", () => {
  const g = mk(["....."], [
    { col: 0, row: 0, target: "west-city", anchor: null, label: "Westtor" },
    { col: 4, row: 0, target: "east-city", anchor: null, label: "Osttor" },
  ]);
  const r = routeOnGrid(g, "Westtor", "Osttor");
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.steps?.map((s) => s.dir), ["osten", "osten", "osten", "osten"]);
});

test("resolveTile: explicit col,row and region name", () => {
  const g = mk([".....", "....."]);
  assert.deepEqual(resolveTile(g, "3,1"), { col: 3, row: 1, name: "3,1" });
  assert.ok(resolveTile(g, "Test"), "region name resolves to a central tile");
});

test("renderGridAscii: includes the legend for gateways", () => {
  const g = mk(["..", ".."], [{ col: 1, row: 1, target: "x", anchor: null, label: "Tor X" }]);
  const art = renderGridAscii(g);
  assert.ok(art.includes("Tor X"), "legend lists the gateway label");
  assert.ok(art.includes("1"), "gateway is marked on the map");
});

test("integration: Asia overworld routes between gateways (if artifact built)", async (t) => {
  const nav = (await loadNavIndex()) ?? (await buildNavInMemory());
  const r = await nav.routeByNames("karte/asia", "Foo-Ling-Yoo", "Nurikomoon-Tempel");
  if (!r.ok && /nicht auf der Karte|nicht gefunden/.test(r.error ?? "")) {
    t.skip("Asia grid artifact not present — run `npm run crawl:gridmaps`");
    return;
  }
  assert.ok(r.ok, r.error);
  assert.ok((r.steps ?? []).length > 0, "a real overworld crossing has steps");
});

test("entranceGateways: synthesizes per-entrance gallierwald gateways (if artifacts built)", async (t) => {
  const gridFile = join(config.kbDir, "_gridmaps", "gallien.json");
  const marco = join(config.kbDir, "_marcopolo", "gallien", "gallien.md");
  if (!existsSync(gridFile) || !existsSync(marco)) {
    t.skip("gallien grid/marcopolo artifacts not present");
    return;
  }
  const grid = JSON.parse(readFileSync(gridFile, "utf8")) as GridMap;
  const gws = await entranceGateways(grid, config.kbDir);
  const wald = gws.filter((g) => g.target === "gallierwald");
  // One gateway per real edge room (N2 E3 S2 W5 = 12), each pinning a distinct
  // "1 Rand" room by coordinate; the original single gateway is superseded.
  assert.equal(wald.length, 12, "12 per-entrance gateways");
  assert.ok(wald.every((g) => /^Rand@\d+,\d+$/.test(g.entry ?? "")), "each pins a coord-addressed Rand room");
  assert.equal(new Set(wald.map((g) => g.entry)).size, 12, "distinct entry rooms");
  assert.ok(!gws.some((g) => g.label === "gallischer Wald"), "original single gateway superseded");
});

test("entranceGateways: leaves gateways unchanged when a region has no marcopolo data", async (t) => {
  const gridFile = join(config.kbDir, "_gridmaps", "asia.json");
  if (!existsSync(gridFile)) { t.skip("asia grid artifact not present"); return; }
  const grid = JSON.parse(readFileSync(gridFile, "utf8")) as GridMap;
  const before = grid.gateways.length;
  const gws = await entranceGateways(grid, config.kbDir);
  assert.equal(gws.length, before, "no marcopolo overworld → gateways untouched (not wiped)");
});
