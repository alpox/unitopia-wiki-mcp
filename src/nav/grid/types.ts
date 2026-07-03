/** Shared types for the raster overworld ("grid map") pipeline. */

export type Dir = "E" | "W" | "N" | "S" | "NE" | "SW" | "NW" | "SE";

export type Terrain = "road" | "grass" | "forest" | "rock" | "water" | "ocean" | "other";

/** A tile that links to another wiki page (city entrance, dimension gate, …). */
export interface Gateway {
  col: number;
  row: number;
  /** Slugged target page, or null for a same-image point of interest. */
  target: string | null;
  anchor: string | null;
  /** Label / gateway room name, e.g. "Foo-Ling-Yoo". */
  label: string;
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
}
