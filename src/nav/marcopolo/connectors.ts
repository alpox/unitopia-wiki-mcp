/**
 * marcopolo connector glyphs — the one reader for which moves a map cell makes,
 * shared by the graph tracer, the portal side detection and the overworld layer.
 */
export const OFF: Record<string, [number, number]> = {
  E: [0, 1], W: [0, -1], N: [-1, 0], S: [1, 0], NE: [-1, 1], SW: [1, -1], NW: [-1, -1], SE: [1, 1],
};
export const DIRS = Object.keys(OFF);

/** The travel axes a connector glyph carries. Arrows and dots carry any axis (the
 *  command is decided from the glyphs seen, not here); `X` is two crossing diagonals. */
export function axesOf(ch: string): string[] | "any" | null {
  if (ch === "-") return ["E", "W"];
  if (ch === "|") return ["N", "S"];
  if (ch === "/") return ["NE", "SW"];
  if (ch === "\\") return ["NW", "SE"];
  if (ch === "X") return ["NE", "SW", "NW", "SE"];
  if (".'^v<>".includes(ch)) return "any";
  return null;
}

/** Does connector glyph `ch`, sitting one step `dir` from a cell, lead into that cell? */
export const carries = (ch: string, dir: string) => {
  const ax = axesOf(ch);
  return ax === "any" || (ax !== null && ax.includes(dir));
};

/** The directions (N, NE, …) a connector leaves cell (r,c) in, or `null` when a
 *  letter sits orthogonally next to it — then it is text (an `M` inside a legend
 *  word), not a map cell whose edges can be read. */
export function cellEdges(rows: string[], r: number, c: number): Set<string> | null {
  const ch = (rr: number, cc: number) => rows[rr]?.[cc] ?? " ";
  for (const d of ["N", "S", "E", "W"]) {
    const g = ch(r + OFF[d][0], c + OFF[d][1]);
    if (g !== " " && axesOf(g) === null) return null;
  }
  return new Set(DIRS.filter((d) => carries(ch(r + OFF[d][0], c + OFF[d][1]), d)));
}
