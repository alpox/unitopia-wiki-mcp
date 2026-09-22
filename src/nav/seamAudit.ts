/**
 * Offline audit of the overworld→sub-map seams (read-only, stdout).
 *
 *   npx tsx src/nav/seamAudit.ts [--region=gallien] [--show=gallierwald]
 *
 * Per gif region: how well the marcopolo overworld registers onto the gif, which
 * marcopolo holes (solid sub-map bodies) exist, the entrances `entranceGateways`
 * injects and whether each sits on its body's rim, and where the imagemap rects and
 * marcopolo's body disagree. `--show` draws a sub-map's surroundings: `#` blocked
 * body, `E` entrance, `r` imagemap rect tile left walkable, terrain otherwise.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { deumlaut } from "./mapGraph.js";
import { parseMcOkf } from "./marcopolo/okf.js";
import { overworldLayer } from "./marcopolo/overworldLayer.js";
import { registerLayer } from "./grid/mcRegister.js";
import { entranceGateways } from "./grid/entranceGateways.js";
import type { GridMap } from "./grid/types.js";

const args = process.argv.slice(2);
const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const only = opt("region"), show = opt("show");
const kb = config.kbDir;
const GLYPH: Record<string, string> = { ocean: " ", grass: ".", forest: ",", rock: "^", sand: "°", water: "~", road: "=", other: ":" };

for (const f of readdirSync(join(kb, "_gridmaps")).filter((f) => f.endsWith(".json"))) {
  const region = f.replace(/\.json$/, "");
  if (only && region !== only) continue;
  const grid = JSON.parse(readFileSync(join(kb, "_gridmaps", f), "utf8")) as GridMap;
  const mc = [region, deumlaut(region)].map((s) => join(kb, "_marcopolo", s, `${s}.md`)).find(existsSync);
  if (!mc) { console.log(`${region}: no marcopolo overworld`); continue; }
  const slug = mc.split("/").slice(-2, -1)[0];
  const over = parseMcOkf(readFileSync(mc, "utf8"), grid.region, slug);
  const layer = overworldLayer(over);
  const reg = registerLayer(grid, layer, over);
  if (!reg) { console.log(`${region}: marcopolo not registrable (fewer than 3 shared landmarks)`); continue; }
  let conf = 0, n = 0;
  for (let tr = 0; tr < layer.rows; tr++) for (let tc = 0; tc < layer.cols; tc++) if (layer.letter(tr, tc)) { n++; if (reg.conf(tr, tc) >= 0.7) conf++; }
  console.log(`\n== ${region}: terrain agreement ${reg.score.toFixed(2)}, registered tiles ${conf}/${n}`);
  console.log(`   marcopolo holes: ${layer.holes.map((h) => `${h.pages[0]}(${h.tiles.length}t/${h.portals.length}p)`).join(" ") || "-"}`);

  const orig = new Set(grid.gateways.map((g) => g.label));
  grid.gateways = await entranceGateways(grid, kb);
  const blocked = (c: number, r: number) => !!grid.blocked?.[r]?.[c];
  const rim = (c: number, r: number) => [[0, 1], [0, -1], [1, 0], [-1, 0]].some(([dr, dc]) => blocked(c + dc, r + dr));
  const byTarget = new Map<string, typeof grid.gateways>();
  for (const g of grid.gateways) if (!orig.has(g.label) && g.target) (byTarget.get(g.target) ?? byTarget.set(g.target, []).get(g.target)!).push(g);
  for (const [t, gs] of byTarget) {
    const off = gs.filter((g) => !rim(g.col, g.row)).length;
    const sm = grid.subMaps?.find((s) => s.target === t);
    let rectOnly = 0, bodyOnly = 0;
    if (sm) {
      const rect = new Set<string>();
      for (const [c1, r1, c2, r2] of sm.boxes) for (let c = c1; c <= c2; c++) for (let r = r1; r <= r2; r++) rect.add(`${c},${r}`);
      for (const k of rect) { const [c, r] = k.split(",").map(Number); if (!blocked(c, r)) rectOnly++; }
      for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) if (blocked(c, r) && !rect.has(`${c},${r}`)) {
        // only count body tiles near this rect
        if ([...rect].some((k) => { const [x, y] = k.split(",").map(Number); return Math.abs(x - c) + Math.abs(y - r) <= 3; })) bodyOnly++;
      }
    }
    console.log(`   ${t.padEnd(22)} ${gs.length} entrances${off ? `, ${off} NOT on a body rim` : ""}${sm ? ` | rect tiles left walkable ${rectOnly}, body outside rect ${bodyOnly}` : ""}`);
  }
  if (show) {
    const sm = grid.subMaps?.find((s) => s.target.endsWith(show));
    const ents = grid.gateways.filter((g) => g.target?.endsWith(show));
    const pts = [...(sm?.boxes.flatMap(([a, b, c, d]) => [[a, b], [c, d]]) ?? []), ...ents.map((g) => [g.col, g.row])];
    if (!pts.length) continue;
    const c0 = Math.max(0, Math.min(...pts.map((p) => p[0])) - 4), c1 = Math.min(grid.cols - 1, Math.max(...pts.map((p) => p[0])) + 4);
    const r0 = Math.max(0, Math.min(...pts.map((p) => p[1])) - 3), r1 = Math.min(grid.rows - 1, Math.max(...pts.map((p) => p[1])) + 3);
    const inRect = (c: number, r: number) => !!sm?.boxes.some(([a, b, cc, d]) => c >= a && c <= cc && r >= b && r <= d);
    const ent = new Set(ents.map((g) => `${g.col},${g.row}`));
    console.log(`\n   ${show}: # body  E entrance  r rect tile left walkable`);
    for (let r = r0; r <= r1; r++) {
      let s = `   ${String(r).padStart(3)} `;
      for (let c = c0; c <= c1; c++) s += ent.has(`${c},${r}`) ? "E" : blocked(c, r) ? "#" : inRect(c, r) ? "r" : GLYPH[grid.tiles[r][c]] ?? "?";
      console.log(s);
    }
  }
}
