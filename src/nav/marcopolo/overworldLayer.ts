/**
 * A marcopolo overworld read as a TILE grid: one tile = one letter cell (every other
 * char on both axes), with the connectors between tiles as its edges. One tile
 * matches one wiki-gif tile (see `grid/mcRegister.ts`).
 *
 * A solid sub-map (forest, walled city) is drawn as a HOLE: blank, wire-less tiles
 * rimmed by the portal cells that link into it. Its painted surroundings are ordinary
 * walkable overworld tiles, so the hole — not the gif paint or the imagemap rect — is
 * what cannot be walked. See [[overworld-ascii-entrance-seam]].
 */
import type { McMap } from "./extract.js";
import { cellEdges } from "./connectors.js";

export interface McPortal { label: string; page: string; tr: number; tc: number; row: number; col: number }
export interface McHole {
  /** Target page basenames of the rim portals, e.g. ["g-wald"]. */
  pages: string[];
  tiles: [number, number][];
  portals: McPortal[];
}
export interface McTileLayer {
  rowParity: number; colParity: number;
  rows: number; cols: number;
  /** Letter drawn on tile (tr,tc), or null for a blank tile. */
  letter(tr: number, tc: number): string | null;
  /** Directions a connector leaves tile (tr,tc) in (null = not a map cell). */
  edges(tr: number, tc: number): Set<string> | null;
  holes: McHole[];
  /** Char position of a tile's cell. */
  charOf(tr: number, tc: number): [number, number];
  /** Tile holding char position (row, col). */
  tileOf(row: number, col: number): [number, number];
}

const basename = (p: string) => p.split("/").pop()!.replace(/\.md$/, "");
const N4: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];
const N8: [number, number][] = [...N4, [1, 1], [1, -1], [-1, 1], [-1, -1]];

export function overworldLayer(m: McMap): McTileLayer {
  const lines = m.ascii.split("\n");
  const ch = (r: number, c: number) => lines[r]?.[c] ?? " ";
  // Letter cells sit on one parity per axis; the other positions hold connectors
  // (including the `X` of a `|X|X|` mesh, which is not a cell).
  const cnt = { r: [0, 0], c: [0, 0] };
  lines.forEach((l, r) => { for (let c = 0; c < l.length; c++) if (/[A-WYZa-z0-9]/.test(l[c])) { cnt.r[r % 2]++; cnt.c[c % 2]++; } });
  const rowParity = cnt.r[1] > cnt.r[0] ? 1 : 0, colParity = cnt.c[1] > cnt.c[0] ? 1 : 0;
  const rows = Math.ceil((lines.length - rowParity) / 2);
  const cols = Math.ceil((Math.max(0, ...lines.map((l) => l.length)) - colParity) / 2);
  const charOf = (tr: number, tc: number): [number, number] => [tr * 2 + rowParity, tc * 2 + colParity];
  const tileOf = (row: number, col: number): [number, number] => [Math.round((row - rowParity) / 2), Math.round((col - colParity) / 2)];
  const letter = (tr: number, tc: number) => { const [r, c] = charOf(tr, tc); const x = ch(r, c); return /[A-Za-z0-9]/.test(x) ? x : null; };
  const edges = (tr: number, tc: number) => { const [r, c] = charOf(tr, tc); return cellEdges(lines, r, c); };

  // Map cells are never horizontally adjacent (a connector slot sits between them),
  // so two or more touching letters are an annotation written into the map
  // ("gall.Wald", "gall. Dorf") and count as empty space.
  const text = new Set<string>();
  lines.forEach((l, r) => {
    for (const m of l.matchAll(/[A-Za-zÄÖÜäöüß]{2}[A-Za-zÄÖÜäöüß0-9.]*/g))
      for (let c = m.index!; c < m.index! + m[0].length; c++) text.add(`${r},${c}`);
  });
  // Every walkable overworld tile carries a letter, so an empty cell is not walkable
  // ground — a connector into it only marks the way in (a gate's `|`).
  const blank = (tr: number, tc: number) => {
    const [r, c] = charOf(tr, tc);
    return ch(r, c) === " " || text.has(`${r},${c}`);
  };

  const portals: McPortal[] = m.cellLinks.map((l) => {
    const [tr, tc] = tileOf(l.row, l.col);
    return { label: l.label, page: basename(l.page), tr, tc, row: l.row, col: l.col };
  });

  const holes: McHole[] = [];
  const seen = new Set<string>();
  for (let tr = 0; tr < rows; tr++) for (let tc = 0; tc < cols; tc++) {
    if (seen.has(`${tr},${tc}`) || !blank(tr, tc)) continue;
    const comp: [number, number][] = [];
    const q: [number, number][] = [[tr, tc]]; seen.add(`${tr},${tc}`);
    let border = false;
    while (q.length) {
      const [a, b] = q.pop()!; comp.push([a, b]);
      if (a === 0 || b === 0 || a === rows - 1 || b === cols - 1) border = true;
      for (const [dr, dc] of N4) {
        const na = a + dr, nb = b + dc, k = `${na},${nb}`;
        if (na < 0 || nb < 0 || na >= rows || nb >= cols || seen.has(k) || !blank(na, nb)) continue;
        seen.add(k); q.push([na, nb]);
      }
    }
    if (border) continue; // open sea / unmapped margin
    const inHole = new Set(comp.map(([a, b]) => `${a},${b}`));
    const rim = portals.filter((p) => [[0, 0], ...N4].some(([dr, dc]) => inHole.has(`${p.tr + dr},${p.tc + dc}`)));
    const pages = [...new Set(rim.map((p) => p.page))];
    if (!pages.length) continue;
    if (pages.length === 1) { holes.push({ pages, tiles: comp, portals: rim }); continue; }
    // Several sub-maps share one blank area: each tile goes to the page of its
    // nearest rim portal.
    for (const page of pages) {
      const mine = rim.filter((p) => p.page === page);
      const tiles = comp.filter(([a, b]) => {
        const d = (p: McPortal) => Math.hypot(p.tr - a, p.tc - b);
        const best = Math.min(...rim.map(d));
        return Math.min(...mine.map(d)) === best;
      });
      holes.push({ pages: [page], tiles, portals: mine });
    }
  }
  // A sub-map can be drawn as several blank pieces; its body is all of them.
  const byPage = new Map<string, McHole>();
  for (const h of holes) {
    const cur = byPage.get(h.pages[0]);
    if (!cur) { byPage.set(h.pages[0], h); continue; }
    cur.tiles.push(...h.tiles);
    for (const p of h.portals) if (!cur.portals.includes(p)) cur.portals.push(p);
  }
  return { rowParity, colParity, rows, cols, letter, edges, holes: [...byPage.values()], charOf, tileOf };
}
