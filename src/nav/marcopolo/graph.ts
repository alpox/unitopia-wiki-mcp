/**
 * Build a topological command-graph from a structured marcopolo map (`McMap`).
 * Nodes = labelled cells (a letter may repeat as several rooms); edges = the
 * command to walk from one to an adjacent one, traced through the connector
 * glyphs. Vertical arrows (`^`/`v`) and marcopolo's flow/climb glyphs become
 * `command: null` edges carrying a `hint` (e.g. "hochklettern"), honouring the
 * rule that an unknown transfer is still an edge. No source ASCII is retained in
 * the output — only nodes and edges. See [[marcopolo-secondary-maps]].
 */
import type { McMap } from "./extract.js";
import type { NavEdge, NavNode } from "../graph/types.js";
import { edge } from "../graph/types.js";

const OFF: Record<string, [number, number]> = {
  E: [0, 1], W: [0, -1], N: [-1, 0], S: [1, 0], NE: [-1, 1], SW: [1, -1], NW: [-1, -1], SE: [1, 1],
};
const COMPASS: Record<string, string> = {
  E: "osten", W: "westen", N: "norden", S: "sueden", NE: "nordosten", SW: "suedwesten", NW: "nordwesten", SE: "suedosten",
};

/** The connector glyphs and which travel axes each one carries. Arrows and dots
 *  are "flexible" (carry any axis) so a run like `..>` or a bare `^` still links
 *  its two endpoints; the *command* is decided separately from the glyphs seen. */
function axesOf(ch: string): string[] | "any" | null {
  if (ch === "-") return ["E", "W"];
  if (ch === "|") return ["N", "S"];
  if (ch === "/") return ["NE", "SW"];
  if (ch === "\\") return ["NW", "SE"];
  if (".'^v<>".includes(ch)) return "any";
  return null;
}

const short = (desc: string): string => desc.split(/[:(\n]/)[0].replace(/\s+/g, " ").trim();

interface Built {
  nodes: NavNode[];
  edges: NavEdge[];
  /** node id → target page basename, for nodes that carry a cross-page link. */
  nodeCross: Map<string, string>;
}

export function buildMcGraph(m: McMap): Built {
  const rows = m.ascii.split("\n");
  const W = Math.max(0, ...rows.map((r) => r.length));
  const grid = rows.map((r) => r.padEnd(W, " ").split(""));
  const H = grid.length;
  const at = (r: number, c: number) => (r >= 0 && r < H && c >= 0 && c < W ? grid[r][c] : " ");
  const region = m.region;
  const slug = m.slug;

  // Cells covered by a (possibly multi-char) cross-page link label.
  const linkAt = new Map<string, { label: string; page: string }>();
  for (const l of m.cellLinks)
    for (let c = l.col; c < l.col + l.label.length; c++) linkAt.set(`${l.row},${c}`, { label: l.label, page: l.page });

  // A cell starts a node if it begins a link label, or it is a lone legend
  // letter (its left neighbour is not part of the same label run).
  const cellNode = new Map<string, string>(); // every occupied cell → node id
  const nodes: NavNode[] = [];
  const nodeCross = new Map<string, string>(); // node id → cross page (if any)
  const mkId = (label: string, r: number, c: number) => `mc:${region.toLowerCase()}:${slug.toLowerCase()}#${label}@${r},${c}`;

  const legendKeys = new Set(Object.keys(m.legend));
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const key = `${r},${c}`;
      if (cellNode.has(key)) continue;
      const link = linkAt.get(key);
      const isLinkStart = link && !linkAt.has(`${r},${c - 1}`);
      const ch = at(r, c);
      const isLegend = legendKeys.has(ch) && !linkAt.has(key);
      if (!isLinkStart && !isLegend) continue;

      const label = isLinkStart ? link!.label : ch;
      const id = mkId(label, r, c);
      const legendLabel = isLinkStart ? label[0] : ch; // single-letter legend lookup
      const name = short(m.legend[legendLabel]?.desc ?? "") || (isLinkStart ? label : ch);
      nodes.push({
        id,
        name: name || null,
        aliases: [],
        region,
        sources: [{ origin: "marcopolo", page: slug, label }],
      });
      const span = isLinkStart ? label.length : 1;
      for (let k = 0; k < span; k++) cellNode.set(`${r},${c + k}`, id);
      if (link) nodeCross.set(id, link.page);
    }
  }

  // Trace an edge from each node in all 8 directions until another node is hit.
  const edges: NavEdge[] = [];
  const seen = new Set<string>();
  const emit = (from: string, to: string, cmd: string | null, hint: string | null) => {
    const k = `${from}>${to}`;
    if (from === to || seen.has(k)) return;
    seen.add(k);
    edges.push(edge(from, to, cmd, "marcopolo", slug, { hint }));
  };

  for (const n of nodes) {
    // Find any cell of this node to launch probes from its bounding cells.
    const cells = [...cellNode.entries()].filter(([, id]) => id === n.id).map(([k]) => k.split(",").map(Number));
    for (const [r, c] of cells) {
      for (const dir of Object.keys(OFF)) {
        const [dr, dc] = OFF[dir];
        let rr = r + dr, cc = c + dc;
        const glyphs: string[] = [];
        // Skip past this node's own remaining label cells.
        while (cellNode.get(`${rr},${cc}`) === n.id) { rr += dr; cc += dc; }
        while (rr >= 0 && rr < H && cc >= 0 && cc < W) {
          const other = cellNode.get(`${rr},${cc}`);
          if (other && other !== n.id) {
            emit(n.id, other, commandFor(dir, glyphs), hintFor(dir, glyphs, m, n));
            break;
          }
          const ax = axesOf(at(rr, cc));
          if (ax === null) break; // blank or unknown → no connection this way
          if (ax !== "any" && !ax.includes(dir)) break; // wire bends off our axis
          glyphs.push(at(rr, cc));
          rr += dr; cc += dc;
        }
      }
    }
  }

  // Custom-command bridges. A node whose legend describes a NON-standard onward
  // traversal ("weiter gehts indem man in den Spalt … kriecht") connects — with
  // NO wire — to a nearby node across a small gap, typically another instance of
  // the SAME label (e.g. Nebelgebirge's two `v`, joined by "krieche durch
  // Spalt"). General over any letter. Represented as a command:null edge whose
  // hint is the legend's instruction. Only fires where the wire tracer found
  // nothing (the `emit` dedup keeps a real wired move authoritative).
  const labelOf = new Map(nodes.map((n) => [n.id, n.sources[0].label]));
  const cellsById = new Map<string, number[][]>();
  for (const [k, id] of cellNode) (cellsById.get(id) ?? cellsById.set(id, []).get(id)!).push(k.split(",").map(Number));
  const GAP = 5;
  for (const n of nodes) {
    const legendLabel = (labelOf.get(n.id) ?? "")[0] ?? "";
    const desc = m.legend[legendLabel]?.desc ?? "";
    if (!SPECIAL_EXIT_RE.test(desc)) continue;
    const instr = customInstruction(desc);
    for (const [r, c] of cellsById.get(n.id) ?? []) {
      for (const dir of ["E", "W", "N", "S"]) {
        const [dr, dc] = OFF[dir];
        let nearest: string | null = null, sameLabel: string | null = null;
        for (let step = 1; step <= GAP; step++) {
          const other = cellNode.get(`${r + dr * step},${c + dc * step}`);
          if (!other || other === n.id) continue;
          if (labelOf.get(other) === labelOf.get(n.id)) { sameLabel = other; break; }
          if (!nearest) nearest = other; // remember, but keep looking for a twin
        }
        const target = sameLabel ?? nearest;
        if (target) emit(n.id, target, null, instr);
      }
    }
  }

  // Structural key: a node that links to another page is a gateway to it. Store
  // the normalized target so the merge can reconcile it with the wiki room that
  // leads to the same place (shared canonical page vocabulary). Basenames are
  // already ASCII (e.g. "Orkhoehlen"), matching the wiki's deumlauted anchors.
  for (const n of nodes) {
    const p = nodeCross.get(n.id);
    if (p) n.portals = [p.toLowerCase().replace(/[^a-z0-9]+/g, "")];
  }

  return { nodes, edges, nodeCross };
}

/** Legend prose that signals a custom onward traversal (not a plain step). */
const SPECIAL_EXIT_RE = /weiter geht|indem man|kriech|spalt|schlüpf|zwäng|seil|abseil|tunnel|graben/i;

/** Condense a custom-traversal legend into an edge hint: the parenthetical that
 *  carries the instruction, else the whole description. */
function customInstruction(desc: string): string {
  const p = /\(([^)]*(?:kriech|spalt|weiter geht|indem|klettert|seil|schwimmt|schlüpf|zwäng)[^)]*)\)/i.exec(desc);
  return (p ? p[1] : desc).replace(/\s+/g, " ").trim();
}

/**
 * The command for a wire run. A vertical arrow (`^`/`v`) is a z-move: by default
 * a stair-like "hoch"/"runter" — NOT necessarily a climb. Marcopolo does not
 * reliably distinguish walking up stairs from climbing from a fully custom verb,
 * so we emit the common case ("hoch"/"runter") and let `hintFor` flag when the
 * legend hints it might really be a climb/special command. A dotted run (`.`) has
 * no clear direction → command unknown (null).
 */
function commandFor(dir: string, glyphs: string[]): string | null {
  const vert = glyphs.includes("^") || glyphs.includes("v");
  if (vert) return dir === "N" ? "hoch" : dir === "S" ? "runter" : COMPASS[dir];
  if (glyphs.includes(".")) return null; // dotted/current: no clear command
  return COMPASS[dir];
}

/** A soft, explicitly-uncertain hint — never asserts a specific climb verb. Only
 *  attached when the source legend text suggests the move is more than a plain
 *  step, or the run is a dotted current with no clear command. */
function hintFor(dir: string, glyphs: string[], m: McMap, from: NavNode): string | null {
  const vert = glyphs.includes("^") || glyphs.includes("v");
  const legendLabel = from.sources[0]?.label?.[0] ?? "";
  const climbHinted = /klettern/i.test(m.legend[legendLabel]?.desc ?? "") || (m.legend[legendLabel]?.climbHints.length ?? 0) > 0;
  if (vert && climbHinted) return "evtl. klettern oder Sonderbefehl – genauer Befehl unklar";
  if (glyphs.includes(".")) return `Richtung ${COMPASS[dir]} – Befehl unklar`;
  return null;
}

/** Cross-page portals: for each node that carried a cross-page link, the target
 *  page basename. The merge step turns these into transition edges between the
 *  two pages' graphs. Returned separately from the room graph. */
export function crossPortals(m: McMap): { nodeLabel: string; row: number; col: number; page: string }[] {
  return m.cellLinks.map((l) => ({ nodeLabel: l.label, row: l.row, col: l.col, page: l.page }));
}
