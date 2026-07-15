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

export interface McEntrance {
  label: string;
  row: number;
  col: number;
  /** target page basename (no dir, no ".md"), e.g. "gallien" or "trabantenstadt" */
  page: string;
  side: Side;
  /** 0-based position along the side (N/S ordered by column, E/W by row) */
  ordinal: number;
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
  const out: McEntrance[] = portals.map((p) => ({
    label: p.nodeLabel, row: p.row, col: p.col, page: basename(p.page),
    side: sideOf(p.row, p.col), ordinal: 0,
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
