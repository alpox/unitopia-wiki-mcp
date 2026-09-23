/**
 * Hand-maintained corrections for single map spots no general rule can read right,
 * each confirmed in-game. A spot is found by its map row's text, not by row/column
 * numbers, so an entry survives re-crawls.
 */
interface Base {
  /** Page slug, e.g. "tadmor". */
  page: string;
  /** Text of the map row that contains the spot (any unique part of it). */
  row: string;
  note: string;
}
/** The two lines crossing at `glyph` pass over each other without a junction. */
export interface CrossoverOverride extends Base {
  kind: "crossover";
  /** The glyph within `row`, and which of its occurrences there (default 0). */
  glyph: string;
  occurrence?: number;
}
/** The drawing itself is wrong: `row` is replaced by `fixed` before parsing. Only for
 *  spots where the columns this shifts are not used by the rows above or below. */
export interface RowFixOverride extends Base {
  kind: "rowFix";
  fixed: string;
}
export type MapOverride = CrossoverOverride | RowFixOverride;

export const MAP_OVERRIDES: MapOverride[] = [
  {
    page: "tadmor", row: "W--┼--o--o--o--o--8-67-K3-K1", glyph: "┼", kind: "crossover",
    note: "At the Westtor the city wall passes over the road: one westen from the o leads straight to W; the wall is reached from the o by `hoch` to 14 (walked 2026-09-23).",
  },
  {
    page: "handelsweg-borsippa", row: "o--o--o--T", fixed: "o--o--o--o--T", kind: "rowFix",
    note: "One road room is missing before T (Westtor von Tadmor): K1 → Handelsweg is 19× westen in-game, the map drew one short (walked 2026-09-23).",
  },
];
