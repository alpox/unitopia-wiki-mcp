/** Shared types for the raster overworld ("grid map") pipeline. */

export type Dir = "E" | "W" | "N" | "S" | "NE" | "SW" | "NW" | "SE";

export type Terrain = "road" | "grass" | "forest" | "rock" | "sand" | "water" | "ocean" | "other";

/** A tile that links to another wiki page (city entrance, dimension gate, …). */
export interface Gateway {
  col: number;
  row: number;
  /** Slugged target page, or null for a same-image point of interest. */
  target: string | null;
  anchor: string | null;
  /** Label / gateway room name, e.g. "Foo-Ling-Yoo". */
  label: string;
  /** For a synthesized entrance gateway: the SPECIFIC room to enter on the target
   *  sub-map, addressed by coordinate (e.g. "Rand@66,0") so it pins one of several
   *  identically-named edge rooms. When set, the seam uses it verbatim instead of
   *  the structural-gate / name-match entry. */
  entry?: string;
}

/** Fully parsed overworld map — the shipped, self-contained routing source. */
export interface GridMap {
  /** Display name, e.g. "Asia". */
  region: string;
  /** Nav page id (slug of region), e.g. "asia". */
  page: string;
  cols: number;
  rows: number;
  tileSize: number;
  /** Pixel offset of the tile grid origin (0 or 1). */
  origin: number;
  /** [row][col] terrain class. */
  tiles: Terrain[][];
  /** [row][col] traversal cost. */
  cost: number[][];
  /** [row][col] road directions (empty array when the tile is not a road). */
  roadDirs: Dir[][][];
  gateways: Gateway[];
  /** [row][col] impassable mask, e.g. an ASCII sub-map's footprint (a forest body
   *  the overworld draws as walkable grass but that you may only ENTER at its edge).
   *  Synthesized at index-build time; absent means nothing is blocked. */
  blocked?: boolean[][];
  /** Overworld FOOTPRINTS of ASCII sub-maps: the whole-region imagemap rects (which
   *  `buildGridMap` drops as gateways) grouped by target page, as inclusive tile
   *  boxes `[c1,r1,c2,r2]`. Baked into the artifact (the imagemap wikitext is NOT
   *  shipped), so `entranceGateways` can block a forest body and place entrances on
   *  its edges without re-reading the imagemap. */
  subMaps?: { target: string; boxes: [number, number, number, number][] }[];
}
