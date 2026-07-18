/**
 * Penetrable overworld↔sub-map entrances from a marcopolo map.
 *
 * marcopolo's `## Verbindungen` section (→ `McMap.cellLinks`, surfaced by
 * `crossPortals`) lists ONLY the cells where you can actually cross between two
 * maps — so it already IS the penetrable-entrance set (impenetrable forest edges
 * are simply absent). This module classifies each crossing onto a side of the
 * crossing-cluster's bounding box and orders them along that side, so the same
 * physical entrance can be matched across two maps by (side, ordinal) — the
 * "counting" correspondence used to map a wiki sub-map's edge rooms to the
 * overworld tiles that reach them. See [[overworld-ascii-entrance-seam]].
 */
import type { McMap } from "./extract.js";
import { crossPortals } from "./graph.js";

export type Side = "N" | "E" | "S" | "W";

/** Distinctive name tokens of a sub-map's LAND border-gate rooms — the rooms whose
 *  marcopolo legend links BACK to the overworld region (a real crossing) and that
 *  are NOT water. For a city these are its gates (Lutetia's `T` = "Stadttor"). Two
 *  uses: (1) a non-empty result CONFIRMS the sub-map is a real crossable city (a land
 *  border-exit exists); (2) the tokens break a near-tie when position alone can't pick
 *  the wiki gate room. Water crossings (a river/Seine `S`) are dropped: a city is
 *  entered by road, not across water, so a water bank is never a road entrance. See
 *  [[overworld-ascii-entrance-seam]]. */
const WATER = /(fluss|fluß|wasser|\bsee\b|meer|bach|seine|ozean|teich|sumpf|hafen)/i;
export function borderGateTokens(sub: McMap, region: string): string[] {
  const out = new Set<string>();
  for (const e of sub.legend) {
    if (!e.pages.includes(region)) continue; // links back to the overworld = a crossing
    const desc = e.desc.replace(/\(.*$/, "").trim(); // drop the "(Nördliches Gallien)" qualifier
    if (!desc || WATER.test(e.desc) || e.color === "0000FF") continue; // water is not a road gate
    for (const tok of desc.toLowerCase().split(/[^a-zäöüß]+/)) if (tok.length >= 5) out.add(tok);
  }
  return [...out];
}

/** The single-char LABELS of a sub-map's LAND border-gate cells (Lutetia's `T`) — a
 *  border-exit legend entry that links back to the region and is not water. Used to
 *  locate the matching gate cells on the OVERWORLD (same label). */
export function landBorderLabels(sub: McMap, region: string): Set<string> {
  const out = new Set<string>();
  for (const e of sub.legend) {
    if (!e.pages.includes(region) || WATER.test(e.desc) || e.color === "0000FF") continue;
    if (/^\S$/.test(e.label)) out.add(e.label);
  }
  return out;
}

export interface GateDirs { side: Side; row: number; col: number; blockedDirs: string[] }
const COMPASS8: Record<string, string> = {
  N: "norden", S: "sueden", E: "osten", W: "westen",
  NE: "nordosten", NW: "nordwesten", SE: "suedosten", SW: "suedwesten",
};
/** For each overworld gate cell of a sub-map (a `landBorderLabels` cell near where the
 *  overworld links to that sub-map), the compass directions marcopolo's connector glyphs
 *  DON'T draw — i.e. the moves that are not walkable from that tile. `|`=N/S, `-`=E/W,
 *  `/`=NE/SW, `\`=NW/SE, `X`=both diagonals; a missing glyph = no edge (e.g. Lutetia's
 *  east Stadttor has a space at its NE corner → "nordosten" blocked). This is marcopolo's
 *  EXACT edge set at the entrance, applied to the matching gif gateway tile — no cross-grid
 *  alignment needed because a compass direction is a compass direction on either map. */
export function overworldGateDirs(over: McMap, landLabels: Set<string>, subSlug: string): GateDirs[] {
  if (!landLabels.size) return [];
  const links = crossPortals(over).filter((p) => basename(p.page) === subSlug);
  if (!links.length) return [];
  const cr = links.reduce((s, l) => s + l.row, 0) / links.length;
  const cc = links.reduce((s, l) => s + l.col, 0) / links.length;
  const rows = over.ascii.split("\n");
  const ch = (r: number, c: number) => rows[r]?.[c] ?? " ";
  const out: GateDirs[] = [];
  for (let r = 0; r < rows.length; r++) for (let c = 0; c < (rows[r]?.length ?? 0); c++) {
    if (!landLabels.has(rows[r][c]) || Math.hypot(r - cr, c - cc) > 12) continue;
    const dr = r - cr, dc = c - cc;
    const side: Side = Math.abs(dc) >= Math.abs(dr) ? (dc < 0 ? "W" : "E") : (dr < 0 ? "N" : "S");
    const blocked: string[] = [];
    if (ch(r - 1, c) !== "|") blocked.push(COMPASS8.N);
    if (ch(r + 1, c) !== "|") blocked.push(COMPASS8.S);
    if (ch(r, c - 1) !== "-") blocked.push(COMPASS8.W);
    if (ch(r, c + 1) !== "-") blocked.push(COMPASS8.E);
    if (!"/X".includes(ch(r - 1, c + 1))) blocked.push(COMPASS8.NE);
    if (!"\\X".includes(ch(r - 1, c - 1))) blocked.push(COMPASS8.NW);
    if (!"/X".includes(ch(r + 1, c - 1))) blocked.push(COMPASS8.SW);
    if (!"\\X".includes(ch(r + 1, c + 1))) blocked.push(COMPASS8.SE);
    out.push({ side, row: r, col: c, blockedDirs: blocked });
  }
  return out;
}

export interface McEntrance {
  label: string;
  row: number;
  col: number;
  /** target page basename (no dir, no ".md"), e.g. "gallien" or "trabantenstadt" */
  page: string;
  side: Side;
  /** 0-based position along the side (N/S ordered by column, E/W by row) */
  ordinal: number;
  /** The straight connecting-edge direction at this cell (marcopolo's authoritative
   *  crossing/side signal), or null if the cell has no unique straight edge (e.g. a
   *  sub-map's outer overlap cell with edges in many directions). On the overworld
   *  side this equals `side`; it is what makes a crossing STRAIGHT-only (never
   *  diagonal). */
  dir: Side | null;
}

const basename = (p: string) => p.split("/").pop()!.replace(/\.md$/, "");

/** Penetrable crossings this map exposes to `targetPage` (basename), classified
 *  per side and ordered along it. Multi-glyph annotation labels (a wald's NAME
 *  cell like "gall.Wald", "Wald-3") are NOT crossings — only single-glyph legend
 *  cells are kept. A corner cell resolves to its row-extreme (N/S) side. */
export function penetrableEntrances(m: McMap, targetPage: string): McEntrance[] {
  const portals = crossPortals(m).filter(
    (p) => basename(p.page) === targetPage && /^\S$/.test(p.nodeLabel),
  );
  if (!portals.length) return [];
  const rows = portals.map((p) => p.row);
  const cols = portals.map((p) => p.col);
  const rmin = Math.min(...rows), rmax = Math.max(...rows);
  const cmin = Math.min(...cols), cmax = Math.max(...cols);
  // Nearest bounding-box edge wins; ties prefer the row-extreme (top/bottom), so a
  // corner counts once (as N or S) instead of inflating an E/W side.
  const sideOf = (r: number, c: number): Side => {
    const dN = r - rmin, dS = rmax - r, dW = c - cmin, dE = cmax - c;
    const min = Math.min(dN, dS, dW, dE);
    if (dN === min) return "N";
    if (dS === min) return "S";
    if (dW === min) return "W";
    return "E";
  };
  // Prefer the straight connecting-edge direction as the side (marcopolo's own
  // signal — reliable at corners, where bbox-nearest-edge is ambiguous); fall back
  // to bounding-box position when the cell has no unique straight edge.
  const out: McEntrance[] = portals.map((p) => ({
    label: p.nodeLabel, row: p.row, col: p.col, page: basename(p.page),
    side: p.edgeDir ?? sideOf(p.row, p.col), ordinal: 0, dir: p.edgeDir,
  }));
  for (const s of ["N", "E", "S", "W"] as Side[]) {
    const grp = out.filter((e) => e.side === s)
      .sort((a, b) => (s === "N" || s === "S" ? a.col - b.col : a.row - b.row));
    grp.forEach((e, i) => { e.ordinal = i; });
  }
  return out;
}

/** Group entrances by side, ordinal-ordered (convenience for matching). */
export function bySide(entrances: McEntrance[]): Record<Side, McEntrance[]> {
  const g: Record<Side, McEntrance[]> = { N: [], E: [], S: [], W: [] };
  for (const e of entrances) g[e.side].push(e);
  for (const s of Object.keys(g) as Side[]) g[s].sort((a, b) => a.ordinal - b.ordinal);
  return g;
}
