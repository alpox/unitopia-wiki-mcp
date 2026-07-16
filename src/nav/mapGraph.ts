/**
 * Deterministic ASCII-map router for Unitopia area pages.
 *
 * Parses the ASCII maps + legends on a page into a room graph (wire-following
 * tracer that handles stretched/bent connectors and crossings), links sub-maps
 * via legend anchors, and computes shortest paths by BFS. Routes are computed
 * entirely in code — no LLM — so the assistant can never hallucinate a way.
 */
import type { NavNode, NavEdge } from "./graph/types.js";
import { edge } from "./graph/types.js";

const BOX = "─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬";
// Underscore appears as map decoration on some maps (e.g. "\_'\_" diagonals on
// the Burg Tregyln map). It carries no direction, but it must be an allowed
// grid char or the row fails the whole-line class test and splits the map.
// `^`/`v` are ASCII stand-ins some maps use for the ˄/˅ up/down arrows (e.g.
// Knossos' Druidengilde sub-map mixes both). Allowed as grid decoration so a
// row like "   ^|        ˄" or "   |   .|˄   v" doesn't fail the class test and
// split the map, orphaning its top half from the legend below.
// `:` is map decoration on some maps (e.g. drachenberge's Klosterberg, a stray
// ":" mid-map). It carries no direction, but it must be an allowed grid char or
// the row fails the class test and SPLITS the map — orphaning a whole fragment
// (and severing the ˄/˅ climbs across it) from the rest and from the legend.
// Lowercase letters still keep real legend/prose lines out of `isMapLine`.
const CLS = new RegExp(`[\\s o~|/\\\\.'_\\-+:0-9A-Z˄˅^v<>▼◄►▲${BOX}]`);
// A map row must contain at least one connector glyph (otherwise a row of pure
// labels/spaces would be mistaken for map art). Box-drawing chars count too:
// maps drawn with │─┌┼ often have corner-only rows ("┌┼┐", "┌┘ ' ˄") that carry
// no ASCII wire char — excluding them here fragments such maps (e.g. Burg
// Tregyln), scattering node markers away from their legend so rooms don't resolve.
const WIRECH = new RegExp(`[o~|/\\\\\\-${BOX}]`);

/** Letters a map's OWN legend declares as terrain glyphs. Uppercase letters are
 *  node labels (handled elsewhere); lowercase ones are CONNECTORS the map draws
 *  as letters instead of wires — a walkable `path` (Pfad/Weg/Straße…) or `water`
 *  you can't walk (Fluss/Bach…). Learned per-page from the Zeichenerklärung so
 *  ANY letter a given map uses is covered — not a hardcoded list — while prose
 *  and legend text (whose letters aren't in this small per-page set) stay
 *  screened out of the graph by the char-class test. `o`/`~`/`v` are skipped:
 *  they are already node/portal glyphs, never connectors. */
export interface ConnGlyphs { path: Set<string>; water: Set<string>; node: Set<string>; }
const EMPTY_CONN: ConnGlyphs = { path: new Set(), water: new Set(), node: new Set() };
// Arrow glyphs a map draws in its art that ALSO appear as a standalone legend
// label pointing at a sub-map (e.g. drachenberge's overview "^" → the six
// mountains: `^ [Klosterberg](#Klosterberg)`). Such a "^" is not a climb glyph —
// it is a GATEWAY room. We promote it to a node ONLY on pages whose legend
// defines it that way (the IFF), and only for ASCII "^" / caret-like arrows, so
// the unicode climb glyphs ˄/˅ used inside detail maps are never disturbed. */
const LABEL_ARROWS = new Set(["^"]);
// A legend letter is a connector only when its definition names a TERRAIN TYPE,
// not a place. This keeps the mechanism general over LETTERS (any letter a map
// assigns to "Pfad"/"Fluss"/… is covered) while the small, stable vocabulary of
// terrain words keeps ordinary node legends ("s Stadttor") and prose from being
// misread as walkable wires — the vocabulary is the generalization axis, not a
// hardcoded letter list. Water is kept separate so we never route along a river.
const PATHWORD = /^(pfad|weg|strasse|gasse|route|steig|steg|treppe|bruecke|furt|damm|pass|allee|promenade|trampelpfad|saumpfad|wanderweg)/;
const WATERWORD = /^(fluss|bach|strom|kanal|graben|see|teich|sumpf|moor|watt|priel|meer|ufer|flut)/;
export function connectorGlyphs(md: string): ConnGlyphs {
  const path = new Set<string>(), water = new Set<string>(), node = new Set<string>();
  for (const ln of md.split("\n")) {
    const m = /^ {0,2}([a-z])\s+([A-Za-zÄÖÜäöü].*)$/.exec(ln);
    if (m && m[1] !== "o" && m[1] !== "v") {
      const w = deumlaut(m[2]);
      if (WATERWORD.test(w)) water.add(m[1]);
      else if (PATHWORD.test(w)) path.add(m[1]);
    }
    // A standalone arrow legend label that links into a sub-map → a gateway node.
    const am = /^\s*(\S)\s+\[[^\]]+\]\(#/.exec(ln);
    if (am && LABEL_ARROWS.has(am[1])) node.add(am[1]);
  }
  return { path, water, node };
}
const isMapLine = (l: string, conn: ConnGlyphs = EMPTY_CONN) =>
  l.length > 4 &&
  (WIRECH.test(l) || [...l].some((c) => conn.path.has(c))) &&
  !/\|\s*:?-{2,}:?\s*\|/.test(l) &&
  [...l].every((c) => CLS.test(c) || conn.path.has(c) || conn.water.has(c));
// A short (≤4-char) wire row that joins TWO nodes with a connector — e.g. "5--4"
// (the Drachenhort/Spalt end of the Drachenkopf map) or "T--1". `isMapLine`'s
// length gate drops these, so they're only accepted as a CONTINUATION of an
// already-open block (see splitGroups), never as a block start — a bare "   |"
// or "   o" is NOT matched, preserving the old block boundaries elsewhere.
const isNodeJoinRow = (l: string) =>
  /^[\s]*[0-9A-Zo~][-/\\|]{1,2}[0-9A-Zo~][\s]*$/.test(l) && [...l].every((c) => CLS.test(c));
const isLegendLine = (l: string) => /^\s*([0-9]{1,2}|[A-Z~])\s+\S/.test(l);
// A map row that holds ONLY node labels (gates/numbers, e.g. "O" or "1     2"
// above the wires they head) has no wire char, so isMapLine rejects it — which
// would drop those rooms or split the map. Treat such a row as map content when
// it directly borders the block, so the gate nodes are created and wired.
// `isLoneLabel` = exactly one label; `isLabelRow` = one or more (e.g. "1     2").
const isLoneLabel = (l: string) => /^\s*[A-Z0-9]{1,3}\s*$/.test(l);
const isLabelRow = (l: string) => l.trim() !== "" && /^(?:\s*[A-Z0-9]{1,3})+\s*$/.test(l);
const anchorOf = (name: string) => name.trim().replace(/\s+/g, "_");
function cleanName(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^()]*(?:\([^()]*\)[^()]*)*\)/g, "$1")
    .replace(/[\[\]*`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface MapGroup {
  anchor: string;
  mapLines: string[];
  labelName: Map<string, string>;
  labelAnchor: Map<string, string[]>;
}
interface GNode {
  gid: string; gi: number; r: number; c: number; cEnd?: number;
  label: string | null; name: string | null; anchors?: string[];
}
export interface RouteStep { dir: string | null; hidden: boolean; transition: string | null; toName: string | null; hint?: string | null; source?: "wiki" | "marcopolo"; }
export interface RouteResult {
  ok: boolean; from?: string; to?: string; steps?: RouteStep[];
  clear?: boolean; ascii?: string; error?: string;
}

const OFF: Record<string, [number, number]> = { E: [0, 1], W: [0, -1], N: [-1, 0], S: [1, 0], NE: [-1, 1], SW: [1, -1], NW: [-1, -1], SE: [1, 1] };
const COMPASS: Record<string, string> = { E: "osten", W: "westen", N: "norden", S: "sueden", NE: "nordosten", SW: "suedwesten", NW: "nordwesten", SE: "suedosten" };
const OPP: Record<string, string> = { E: "W", W: "E", N: "S", S: "N", NE: "SW", SW: "NE", NW: "SE", SE: "NW" };
// Compass ring in clockwise order — lets the tracer step a heading ±45° when a
// diagonal wire (esp. a column-shifting climb) drifts off pure vertical.
const RING = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const turn = (d: string, k: number): string => RING[(RING.indexOf(d) + k + 8) % 8];
const FLEX = ".'˄˅^v";
// Vertical (z-axis) portal glyphs: ˄ Hoch, ˅ Runter (with ASCII ^/v synonyms).
// A wire that runs through one is a climb/descent, not a compass move — labelled
// by travel direction.
const VERT = "˄˅^v";
// The up/down sense of a climb glyph: ˄/^ = hoch (+1), ˅/v = runter (-1). Used to
// label a climb move whose net row travel is zero (a horizontal ridge crossing,
// e.g. "o ˄ ˅ o") by the glyph the walk actually climbed onto, not by geometry.
const climbSign = (ch: string): number => (ch === "˄" || ch === "^" ? 1 : ch === "˅" || ch === "v" ? -1 : 0);
const wireDirs = (ch: string): string[] =>
  ch === "-" || ch === "─" || ch === "═" ? ["E", "W"]
  : ch === "|" || ch === "│" || ch === "║" ? ["N", "S"]
  : ch === "/" ? ["NE", "SW"]
  : ch === "\\" ? ["NW", "SE"]
  : "┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬+".includes(ch) ? Object.keys(OFF) // drawn junctions/corners (and ASCII '+'): connect through
  : "►◄><".includes(ch) ? ["E", "W"] // direction arrows: traverse along their axis
  : "▲▼".includes(ch) ? ["N", "S"]
  : FLEX.includes(ch) ? Object.keys(OFF)
  : [];

function splitGroups(md: string, conn: ConnGlyphs = connectorGlyphs(md)): MapGroup[] {
  const lines = md.split("\n");
  const groups: MapGroup[] = [];
  let curHeading = "";
  let i = 0;
  while (i < lines.length) {
    const h = /^#{1,6}\s+\[?([^\]\n]+?)\]?(\(#?[^)]*\))?\s*$/.exec(lines[i]);
    if (h && !isMapLine(lines[i], conn)) curHeading = anchorOf(h[1].replace(/\]\(.*$/, ""));
    if (isMapLine(lines[i], conn)) {
      let start = i;
      // Pull in leading label-only rows that head the wires directly below them
      // (e.g. the "1     2" gate row atop Foo-Ling-Yoo's Stadtplan) — they carry
      // real node labels but no wire char, so isMapLine skips them otherwise.
      while (start > 0 && isLabelRow(lines[start - 1])) start--;
      while (i < lines.length && (isMapLine(lines[i], conn) || lines[i].trim() === "" ||
        (isLabelRow(lines[i]) && i > start && lines[i - 1].trim() !== "" && (isMapLine(lines[i - 1], conn) || isLabelRow(lines[i - 1]))) ||
        // A short "5--4"-style node-join row directly under existing map art.
        (isNodeJoinRow(lines[i]) && i > start && isMapLine(lines[i - 1], conn)))) i++;
      let end = i; while (end > start && lines[end - 1].trim() === "") end--;
      const mapLines = lines.slice(start, end);
      const labelName = new Map<string, string>(), labelAnchor = new Map<string, string[]>();
      // A legend entry can reference SEVERAL sub-map anchors across its main line
      // and its continuation lines (e.g. "O [Osttor](#Stadtmauer)" + "(… [Richtung
      // Hafen](#Hafen))"). Collect them all, so a gateway that also leads to a
      // second area (the harbour) bridges there too — not only to its first link.
      const addAnchors = (key: string, text: string) => {
        const arr = labelAnchor.get(key) ?? [];
        for (const am of text.matchAll(/\]\(#([^)]+)\)/g)) {
          const a = decodeURIComponent(am[1]);
          if (!arr.includes(a)) arr.push(a);
        }
        if (arr.length) labelAnchor.set(key, arr);
      };
      let j = i, miss = 0, last: string | null = null;
      while (j < lines.length && miss < 4 && !isMapLine(lines[j], conn)) {
        const ln = lines[j];
        if (ln.trim() === "") { j++; continue; } // blank: neutral, keep legend context
        const m = /^\s*([0-9]{1,3}|[A-Z]{1,2}[0-9]?|~|\^)\s+(\S.*)$/.exec(ln);
        if (m) {
          if (!labelName.has(m[1])) labelName.set(m[1], cleanName(m[2]));
          addAnchors(m[1], m[2]);
          last = m[1]; miss = 0;
        } else if (last && /^\s*[([]/.test(ln)) {
          labelName.set(last, (labelName.get(last) + " " + cleanName(ln)).trim());
          addAnchors(last, ln);
        } else { miss++; last = null; }
        j++;
      }
      if (mapLines.length >= 3) groups.push({ anchor: curHeading, mapLines, labelName, labelAnchor });
    } else i++;
  }
  return groups;
}

interface PageGraph { nodes: Map<string, GNode>; adj: Map<string, RouteStep[] & { to: string }[] | any>; grids: string[][][]; }

function buildGraph(groups: MapGroup[], conn: ConnGlyphs = EMPTY_CONN) {
  const nodes = new Map<string, GNode>();
  const adj = new Map<string, { to: string; dir: string | null; hidden: boolean; transition: string | null }[]>();
  const groupNodes: string[][] = [];
  const grids: string[][][] = [];
  // Normalize legend-defined connector letters to glyphs the tracer already
  // understands: a walkable `path` letter becomes a "." (a "path exists, command
  // from geometry / unclear" run — exactly the legend's own meaning), and a
  // `water` letter becomes blank (present so its line survived the class test,
  // but not a walkable edge — never invent a river you can stroll along).
  const remap = (l: string) =>
    conn.path.size || conn.water.size
      ? [...l].map((c) => (conn.path.has(c) ? "." : conn.water.has(c) ? " " : c)).join("")
      : l;

  groups.forEach((g, gi) => {
    const W = Math.max(...g.mapLines.map((l) => l.length));
    const grid = g.mapLines.map((l) => remap(l).padEnd(W, " ").split(""));
    grids[gi] = grid;
    const Hh = grid.length;
    const at = (r: number, c: number) => (r >= 0 && r < Hh && c >= 0 && c < W ? grid[r][c] : " ");
    const isNode = (ch: string) => ch === "o" || ch === "~" || /[A-Z]/.test(ch) || conn.node.has(ch);
    const gid = (r: number, c: number) => `${gi}:${r},${c}`;
    const local: string[] = []; groupNodes[gi] = local;
    for (let r = 0; r < Hh; r++) for (let c = 0; c < W; c++) if (isNode(at(r, c))) {
      let lbl = /[A-Z]/.test(at(r, c)) ? at(r, c) : conn.node.has(at(r, c)) ? at(r, c) : null;
      let cEnd = c;
      // "K3" — an uppercase letter glued to digits — is ONE multi-char legend
      // label (e.g. the four Kartukultininurta-Platz corners K1..K4), not a
      // letter node plus a stray digit. Consume the digits so each corner is a
      // single node; otherwise the straight east edge K3—K1 (3 hops through the
      // split digit-nodes) loses to the X-crossing's 2-hop diagonal zigzag and
      // the path detours south then north.
      if (lbl) while (/[0-9]/.test(at(r, cEnd + 1))) lbl += grid[r][++cEnd];
      const id = gid(r, c);
      nodes.set(id, { gid: id, gi, r, c, cEnd: cEnd > c ? cEnd : undefined, label: lbl, name: lbl ? g.labelName.get(lbl) ?? null : null, anchors: lbl ? g.labelAnchor.get(lbl) : undefined });
      adj.set(id, []); local.push(id);
    }
    // A digit is a free node (not a label for a nearby `o`) if a real wire
    // touches it. ˄/˅ are NOT wires — they annotate a z-move on a SEPARATE wire
    // (e.g. "o  1" with "| ˄" to the left: the ˄ belongs to the o's vertical
    // link, not to the "1" label). Counting them here wrongly detached the
    // Drachenkopf "1" from its `o`, so exclude them from the wire-touch test.
    const EDGECH = "|/\\-.'" + BOX;
    for (let r = 0; r < Hh; r++) for (let c = 0; c < W; c++)
      if (/[0-9]/.test(at(r, c)) && !/[0-9]/.test(at(r, c - 1)) && !/[A-Z]/.test(at(r, c - 1))) {
        let c2 = c; while (/[0-9]/.test(at(r, c2 + 1))) c2++;
        const num = grid[r].slice(c, c2 + 1).join("");
        let adjEdge = false;
        for (let rr = r - 1; rr <= r + 1; rr++) for (let cc = c - 1; cc <= c2 + 1; cc++) if (EDGECH.includes(at(rr, cc))) adjEdge = true;
        let best: GNode | null = null, bk = [99, 99];
        for (const id of local) { const n = nodes.get(id)!; if (n.label) continue; const rowD = Math.abs(n.r - r), colD = Math.min(Math.abs(n.c - c), Math.abs(n.c - c2)); if (!((rowD <= 1 && colD <= 6) || Math.max(rowD, colD) <= 2)) continue; if (rowD < bk[0] || (rowD === bk[0] && colD < bk[1])) { bk = [rowD, colD]; best = n; } }
        const attach = best && (Math.max(bk[0], bk[1]) <= 1 || (!adjEdge && bk[0] === 0));
        if (attach && best) {
          best.label = num; best.name = g.labelName.get(num) ?? null; best.anchors = g.labelAnchor.get(num);
          // Extend the node's column span to cover a detached right-side label
          // (e.g. "o  1"): wires that meet the label's column (here the "H" link
          // up col 9) must still resolve to this room, not dead-end in the gap.
          if (c2 > best.c) best.cEnd = Math.max(best.cEnd ?? best.c, c2);
        }
        else { const id = gid(r, c); nodes.set(id, { gid: id, gi, r, c, cEnd: c2, label: num, name: g.labelName.get(num) ?? null, anchors: g.labelAnchor.get(num) }); adj.set(id, []); local.push(id); }
      }
    // Climb wires are often drawn with the ˄/˅ markers SPACED OUT (e.g. the row
    // "N--o ˄ ˅ o"): the up/down glyphs sit a blank apart, yet the two rooms they
    // string together ARE connected. Bridge such single-blank gaps by filling a
    // blank that lies on a straight axis (H, V, or a diagonal) between two climb
    // markers — or between a climb marker and a node — reconstructing the intended
    // climb wire so the tracer can follow it. A real ˄/˅ must sit on one side, so
    // ordinary gaps between rooms are never fused.
    const isClimb = (ch: string) => VERT.includes(ch);
    const nodeCell = (r: number, c: number) => isNode(at(r, c)) || /[0-9]/.test(at(r, c));
    const AX: [number, number][] = [[0, 1], [1, 0], [1, 1], [1, -1]];
    const fills: [number, number][] = [];
    for (let r = 0; r < Hh; r++) for (let c = 0; c < W; c++) {
      if (at(r, c) !== " ") continue;
      for (const [dr, dc] of AX) {
        const aC = isClimb(at(r - dr, c - dc)), bC = isClimb(at(r + dr, c + dc));
        if ((aC && (bC || nodeCell(r + dr, c + dc))) || (bC && nodeCell(r - dr, c - dc))) { fills.push([r, c]); break; }
      }
    }
    const filled = new Set<string>();
    for (const [r, c] of fills) { grid[r][c] = "˄"; filled.add(`${r},${c}`); }
    // Map a cell to a node, treating a multi-char label as occupying its whole
    // column span [c, cEnd] so wires adjacent to any part of the label connect.
    const nodeAt = (r: number, c: number) => {
      if (nodes.has(gid(r, c))) return nodes.get(gid(r, c))!;
      for (const id of local) {
        const n = nodes.get(id)!; const ce = n.cEnd ?? n.c;
        const colDist = c < n.c ? n.c - c : c > ce ? c - ce : 0;
        if (Math.abs(n.r - r) <= 1 && colDist <= 1) return n;
      }
      return null;
    };
    // A node flanked by dots (./') on the travel axis is *crossed under*: the
    // line (e.g. the river in "F-.6..7.-F") passes beneath it with NO junction,
    // so 6/7 are not reachable from the river — the trace continues straight.
    const DOTS = ".'";
    const underCrossed = (r: number, c: number, wd: string) =>
      wd === "E" || wd === "W" ? DOTS.includes(at(r, c - 1)) && DOTS.includes(at(r, c + 1))
        : wd === "N" || wd === "S" ? DOTS.includes(at(r - 1, c)) && DOTS.includes(at(r + 1, c))
          : false;
    // A ˄/˅ "hoch/runter" glyph marks a z-axis move. Maps draw it either ON the
    // wire (Gebirge: the P–W link) or just BESIDE a vertical "|" (Drachenkopf:
    // the 1–2 link has "|˅"/"| ˄" to the right of the wire). So a cell counts as
    // a vertical portal if it or an orthogonal neighbour is a ˄/˅. (Only N/S
    // moves become hoch/runter — see zLabel — so a stray arrow near a horizontal
    // wire is harmless.)
    // Only ORIGINAL ˄/˅ glyphs count as "beside a climb" — a gap-fill glyph (added
    // to bridge a spaced-out climb wire) must not bleed vert-ness onto an adjacent
    // ground diagonal (which would mislabel a plain suedwesten walk as "runter").
    const rv = (r: number, c: number) => VERT.includes(at(r, c)) && !filled.has(`${r},${c}`);
    const nearVert = (r: number, c: number) =>
      rv(r, c) || rv(r, c - 1) || rv(r, c + 1) || rv(r - 1, c) || rv(r + 1, c);
    const walkableCell = (r: number, c: number) => { const ch = at(r, c); return isNode(ch) || /[0-9]/.test(ch) || wireDirs(ch).length > 0; };
    // A ˄/˅ climb is followed as a SINGLE path with angular preference: keep the
    // arrival heading, and only when that is blocked take the least turn (±45°, then
    // ±90°). This lands the walk on the ladder's rooms (no gutter-snaking spurious
    // edges) and refuses to fan onto a crossing ' line, yet still lets a climb marker
    // that sits on a BEND — e.g. the "˅--+---" where a climb meets the horizontal
    // Klosterberg way — turn from its SE arrival onto the way instead of dead-ending.
    const climbStep = (r: number, c: number, adir: string, seen: Set<string>): string[] => {
      for (const d of [adir, turn(adir, 1), turn(adir, -1), turn(adir, 2), turn(adir, -2)]) {
        const nr = r + OFF[d][0], nc = c + OFF[d][1];
        if (!seen.has(`${nr},${nc}`) && walkableCell(nr, nc)) return [d];
      }
      return [];
    };
    // A wiki '+'/'┼'/'╬' is drawn as an all-directions junction, but where two
    // DIFFERENT features cross — a Bach (water) flowing across a Weg — it is a
    // *crossover*, not a junction: the lines pass over/under one another and do
    // NOT interconnect (you'd have to klettern between them; marcopolo draws the
    // Bach a level below, reached only via "kletter runter/hoch", never a plain
    // walk — the legend even says the Bach flows "unter dem Handelsweg"). Flag a
    // full 4-way cross whose ONE axis is water and the other is not, so the tracer
    // passes straight through it instead of turning onto the crossing line. A '+'
    // with no water axis (Tadmor's "8--+--8" real junction) is left untouched, so
    // this can never mis-split a genuine junction. See [[marcopolo-secondary-maps]].
    const CROSS = "+┼╬", HWIRE = "-─═►◄><+┼╬", VWIRE = "|│║▲▼˄˅^v+┼╬";
    const walkAxis = (r: number, c: number, dir: string): GNode | null => {
      const [dr, dc] = OFF[dir]; let rr = r + dr, cc = c + dc;
      for (let g = 0; g < 200; g++) {
        const ch = at(rr, cc);
        if (isNode(ch) || /[0-9]/.test(ch)) return nodeAt(rr, cc);
        if (wireDirs(ch).length === 0) return null; // ran off the wire before a room
        rr += dr; cc += dc;
      }
      return null;
    };
    const isWater = (n: GNode | null) => !!n?.name && WATER_RE.test(n.name);
    // A '+' whose perpendicular axis is a "'" quote-run (a "keine erkennbare
    // Himmelsrichtung" climb/unknown path) crossing a plain wire is ALSO a
    // crossover, not a junction: the quote-path passes over the way without
    // joining it (e.g. drachenberge's "˅--+---" where a climb-path's ' quotes
    // cross the horizontal Klosterberg way). Without this the '+' fans onto the
    // quotes and welds the way to the climb-path, fragmenting/mis-wiring the map.
    const crossover = new Set<string>();
    for (let r = 0; r < Hh; r++) for (let c = 0; c < W; c++) {
      if (!CROSS.includes(at(r, c))) continue;
      if (!(VWIRE.includes(at(r - 1, c)) && VWIRE.includes(at(r + 1, c)) &&
            HWIRE.includes(at(r, c - 1)) && HWIRE.includes(at(r, c + 1)))) continue; // not a full 4-way cross
      const hW = isWater(walkAxis(r, c, "E")) || isWater(walkAxis(r, c, "W"));
      const vW = isWater(walkAxis(r, c, "N")) || isWater(walkAxis(r, c, "S"));
      if (hW !== vW) crossover.add(`${r},${c}`); // exactly one crossing line is water → crossover
    }
    for (const id of local) {
      const n = nodes.get(id)!;
      const ce = n.cEnd ?? n.c;
      const found = new Map<string, { dir: string; hidden: boolean }>();
      for (const startDir of Object.keys(OFF)) {
        const [sr, sc] = OFF[startDir];
        // Probe from the edge of the label span in the travel direction, so a
        // wire starting past a multi-char label ("47--o") is still reached.
        const fr = n.r + sr;
        let fc = sc > 0 ? ce + 1 : sc < 0 ? n.c - 1 : n.c;
        // A vertical probe off a MULTI-char label: the wire may sit under any of the
        // label's columns (e.g. the "|" under the second digit of "14"), not just the
        // leftmost — scan the span so a north/south exit isn't missed.
        if (sc === 0 && ce > n.c) for (let cc = n.c; cc <= ce; cc++) if (wireDirs(at(fr, cc)).length) { fc = cc; break; }
        const fch = at(fr, fc);
        // If THIS node is flanked by dots (./') on both sides of the probe axis,
        // a perpendicular line is crossing under/over it (e.g. the vertical river
        // ". 8 ." under the Alte Brücke street, or "F-.6..7.-F" horizontally).
        // The node does not connect along that axis — the crossing line owns it.
        // (A single mid-wire bend dot has no dot on the far side, so it is not
        // mistaken for a crossing and legitimate connections survive.)
        const flanked =
          startDir === "N" || startDir === "S" ? DOTS.includes(at(n.r - 1, n.c)) && DOTS.includes(at(n.r + 1, n.c))
            : startDir === "E" || startDir === "W" ? DOTS.includes(at(n.r, n.c - 1)) && DOTS.includes(at(n.r, ce + 1))
              : false;
        if (flanked) continue;
        if (isNode(fch) || /[0-9]/.test(fch)) { if (!underCrossed(fr, fc, startDir)) { const t = nodeAt(fr, fc); if (t && t.gid !== id && !found.has(t.gid)) found.set(t.gid, { dir: COMPASS[startDir], hidden: false }); } continue; }
        if (wireDirs(fch).length === 0) continue;
        const seen = new Set([`${fr},${fc}`]);
        // Frontier flags: hasApos (crossed a "'" → command unknown), hasDir (has a
        // definite compass dir), vert (near/on a ˄/˅ portal → hoch/runter), adir
        // (arrival direction), and csign (the up/down sense of the FIRST real climb
        // glyph stepped onto — labels a net-horizontal climb; 0 until one is met).
        const q: [number, number, boolean, boolean, boolean, string, number][] = [[fr, fc, fch === "'", !FLEX.includes(fch) || nearVert(fr, fc), nearVert(fr, fc), startDir, filled.has(`${fr},${fc}`) ? 0 : climbSign(fch)]];
        while (q.length) {
          const [r, c, hasApos, hasDir, vert, adir, csign] = q.shift()!;
          // Two kinds of cell are traversed STRAIGHT (only the arrival direction),
          // never fanned out:
          //  - a flagged crossover '+': the Weg passes over the Bach without them
          //    interconnecting;
          //  - a '/. dotted cell: dots mark a LINEAR "path exists, command unknown"
          //    run (or a way-extension), NOT a junction. Fanning out across a FIELD
          //    of dots invents edges that don't exist (e.g. a spurious 14→Wasserfall
          //    shortcut, or a collapsed 14→Bach, both cutting straight through the
          //    dot mesh) — a real descent is `14 ·→ Felsterasse ·→ Bach`, two steps.
          const cch = at(r, c);
          // Per-glyph continuation rule (replaces the blanket all-8 fan that welded
          // crossing lines). Three glyph kinds are traversed STRAIGHT — the arrival
          // direction only, never fanned:
          //  - a flagged crossover '+': the Weg passes over the Bach without joining;
          //  - a '/. dotted cell: a dot run is a LINEAR "command unknown" path;
          //  - a ˄/˅ CLIMB cell: a climb wire is a straight run (vertical, a pure
          //    diagonal, or — once its spaced markers are gap-filled — horizontal).
          //    Going straight lands the walk ON the ladder's rooms instead of
          //    snaking up the gutter beside them (which used to mint spurious
          //    room-skipping climb edges), and never fans onto a crossing ' line.
          // Everything else (straight wires, drawn junctions) keeps its own wireDirs,
          // so a real junction still fans out — correct at a genuine branch.
          const cellDirs = VERT.includes(cch)
            ? climbStep(r, c, adir, seen)
            : crossover.has(`${r},${c}`) || DOTS.includes(cch)
              ? wireDirs(cch).filter((d) => d === adir)
              : wireDirs(cch);
          for (const wd of cellDirs) {
            const [dr, dc] = OFF[wd], nr = r + dr, nc = c + dc, nch = at(nr, nc);
            if (isNode(nch) || /[0-9]/.test(nch)) {
              if (underCrossed(nr, nc, wd)) {
                // pass under this node, continue straight in the same direction
                const ar = nr + dr, ac = nc + dc, akey = `${ar},${ac}`;
                if (!seen.has(akey) && wireDirs(at(ar, ac)).length) { seen.add(akey); q.push([ar, ac, hasApos, hasDir, vert, wd, csign]); }
                continue;
              }
              // A "'"/dot on the path makes the step's COMMAND unknown (the legend:
              // "keine erkennbare Himmelsrichtung"). A ˄/˅ portal only tells us the
              // room lies higher/lower — a useful hint (dir = hoch/runter) — but does
              // NOT clear `hidden`: you still can't just "hoch", you have to tüfteln
              // (a "klettere hoch"-type move). So keep hidden when hasApos/!hasDir.
              // Labelling a move on arrival at node t:
              //  - if the walk stepped on a real climb glyph (csign≠0): it is a climb.
              //    hoch/runter by NET ROW travel; a horizontal ridge (same row) reads
              //    the glyph's own sense (˄→hoch, ˅→runter) — a climb wire never reads
              //    as a compass move.
              //  - else if it merely ran BESIDE a ˄/˅ (vert) on a real vertical wire:
              //    hoch/runter by row travel, else compass (a stray arrow by a
              //    horizontal wire stays a compass move).
              //  - else: plain compass.
              const t = nodeAt(nr, nc);
              if (t && t.gid !== id && !found.has(t.gid)) {
                const dir = csign !== 0
                  ? (t.r < n.r ? "hoch" : t.r > n.r ? "runter" : csign > 0 ? "hoch" : "runter")
                  : vert && t.r !== n.r ? (t.r < n.r ? "hoch" : "runter") : COMPASS[startDir];
                found.set(t.gid, { dir, hidden: hasApos || !hasDir });
              }
              continue;
            }
            const key = `${nr},${nc}`; if (seen.has(key)) continue;
            const nd = wireDirs(nch); if (nd.length === 0) continue;
            if (!FLEX.includes(nch) && !FLEX.includes(at(r, c)) && !nd.includes(OPP[wd])) continue;
            seen.add(key); q.push([nr, nc, hasApos || nch === "'", hasDir || !FLEX.includes(nch) || nearVert(nr, nc), vert || nearVert(nr, nc), wd, csign !== 0 ? csign : filled.has(key) ? 0 : climbSign(nch)]);
          }
        }
        for (const [to, e] of found) if (!adj.get(id)!.some((x) => x.to === to)) adj.get(id)!.push({ to, dir: e.dir, hidden: e.hidden, transition: null });
      }
    }
  });

  // bridge sub-maps via anchors
  const entries = (gi: number, fromAnchor: string) => {
    const back = groupNodes[gi].filter((id) => nodes.get(id)!.anchors?.includes(fromAnchor));
    if (back.length) return back;
    const named = groupNodes[gi].find((id) => nodes.get(id)!.name);
    return named ? [named] : groupNodes[gi].slice(0, 1);
  };
  // Count how many nodes per group share each anchor: a real gateway (a single
  // Tor) is used once or twice; terrain like the river/Ufer reuses the same
  // anchor (#Dijala) on dozens of tiles. Bridging the latter would turn the
  // river into a portal hub that shortcuts the whole map — so skip those.
  const anchorUse = new Map<string, number>();
  for (const n of nodes.values()) for (const a of n.anchors ?? []) anchorUse.set(`${n.gi}:${a}`, (anchorUse.get(`${n.gi}:${a}`) ?? 0) + 1);
  // A legend #anchor often names the sub-map loosely: "#Klosterberg" targets the
  // heading "Klosterberg (Luntayberg)". Resolve to a group by exact anchor, then
  // deumlauted equality, then a separator-insensitive prefix (≥4 chars, so a
  // gateway "^ [Klosterberg](#Klosterberg)" still reaches its detail sub-map).
  const normA = (s: string) => deumlaut(s).replace(/[^a-z0-9]+/g, "");
  const anchorGroup = (anchor: string): number => {
    let gi = groups.findIndex((g) => g.anchor === anchor);
    if (gi < 0) gi = groups.findIndex((g) => g.anchor && deumlaut(g.anchor) === deumlaut(anchor));
    if (gi < 0) { const na = normA(anchor); if (na.length >= 4) gi = groups.findIndex((g) => g.anchor && normA(g.anchor).startsWith(na)); }
    return gi;
  };
  for (const n of [...nodes.values()]) {
    for (const anchor of n.anchors ?? []) {
      if ((anchorUse.get(`${n.gi}:${anchor}`) ?? 0) > 3) continue; // terrain, not a gateway
      const tg = anchorGroup(anchor);
      if (tg < 0 || tg === n.gi) continue;
      for (const entry of entries(tg, groups[n.gi].anchor)) {
        if (!entry || entry === n.gid) continue;
        if (!adj.get(n.gid)!.some((x) => x.to === entry)) adj.get(n.gid)!.push({ to: entry, dir: null, hidden: false, transition: `Übergang nach ${nodes.get(entry)!.name ?? anchor}` });
        if (!adj.get(entry)!.some((x) => x.to === n.gid)) adj.get(entry)!.push({ to: n.gid, dir: null, hidden: false, transition: `Übergang nach ${n.name ?? groups[n.gi].anchor}` });
      }
    }
  }
  // Name-based cross-reference bridges. A letter-labelled node often names a room
  // that really lives on ANOTHER sub-map (e.g. a building's "K Platz des Talos"
  // is the Stadtplan's numbered "Platz des Talos" hub). Such cross-refs commonly
  // link to the external page URL (/knossos.md) instead of an in-page #anchor, so
  // the anchor bridge above misses them — leaving a sub-map reachable ONLY through
  // whatever DID use a proper #anchor (the Kanalisation), which is why routes to
  // the Druidengilde detoured through the sewer. Bridge a single-letter cross-ref
  // to the numbered room of the same name when that room lives on exactly one
  // other sub-map (unambiguous), so the plaza hub reconnects the buildings.
  const realByName = new Map<string, GNode[]>();
  for (const n of nodes.values()) if (n.name && n.label && /^\d+$/.test(n.label)) {
    const k = deumlaut(n.name); const arr = realByName.get(k); if (arr) arr.push(n); else realByName.set(k, [n]);
  }
  for (const n of [...nodes.values()]) {
    if (!n.name || !n.label || !/^[A-Z]$/.test(n.label)) continue; // source = single-letter cross-ref
    const targets = (realByName.get(deumlaut(n.name)) ?? []).filter((m) => m.gi !== n.gi);
    if (new Set(targets.map((m) => m.gi)).size !== 1) continue; // none, or ambiguous across sub-maps
    for (const m of targets) {
      if (!adj.get(n.gid)!.some((x) => x.to === m.gid)) adj.get(n.gid)!.push({ to: m.gid, dir: null, hidden: false, transition: `Übergang nach ${m.name}` });
      if (!adj.get(m.gid)!.some((x) => x.to === n.gid)) adj.get(m.gid)!.push({ to: n.gid, dir: null, hidden: false, transition: `Übergang nach ${n.name}` });
    }
  }
  return { nodes, adj, grids };
}

/** Normalize for matching: lowercase + transliterate German umlauts to ASCII. */
export function deumlaut(s: string): string {
  return s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").trim();
}

const STOPWORDS = new Set(["der", "die", "das", "dem", "den", "des", "ein", "eine", "einen", "einem", "einer", "mit", "in", "im", "von", "vom", "zum", "zur", "und", "oder", "am", "an", "auf", "aus", "bei", "ueber", "the", "of"]);
/** Significant tokens of a name/query (deumlauted, stopwords/short words dropped). */
export function roomTokens(s: string): string[] {
  return [...new Set(deumlaut(s).split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOPWORDS.has(t)))];
}
/** True if any query token loosely matches a token of `name` (substring either way). */
export function tokenOverlap(queryTokens: string[], name: string): boolean {
  if (!queryTokens.length) return false;
  const r = roomTokens(name);
  return queryTokens.some((q) => r.some((x) => x.includes(q) || q.includes(x)));
}

function findNode(nodes: Map<string, GNode>, adj: Map<string, { to: string }[]>, q: string, groupAnchors: string[] = [], preferGi = -1): GNode | null {
  const ql = deumlaut(q);
  // The sub-map (group) whose heading equals an anchor, i.e. its area name.
  const groupGi = (anchor: string) => groupAnchors.findIndex((a) => a && deumlaut(a) === deumlaut(anchor));
  // A sub-map's primary room: its lowest-numbered labelled room (rooms are
  // numbered from their main/entry room, e.g. the harbour's "1 Steg (Kurstafel)"),
  // falling back to any labelled node in the group.
  const primaryOf = (gi: number): GNode | null => {
    const inGroup = [...nodes.values()].filter((n) => n.gi === gi && n.label);
    const numbered = inGroup.filter((n) => /^\d+$/.test(n.label!)).sort((a, b) => +a.label! - +b.label!);
    return numbered[0] ?? inGroup[0] ?? null;
  };
  // Some tiles exist ONLY as a cross-reference into another sub-map on the same
  // page — a bridge anchor whose whole name IS that area's name (e.g. the
  // "H [Hafengebiet](#Hafen)" tile on the Felder/Stadtmauer maps, which just
  // means "here you cross into the harbour"). Matching a destination onto such a
  // tile strands the route on the wrong side (the Stadtgraben, not the Steg), so
  // redirect it into the target area's primary room. The test uses the name with
  // any parenthetical qualifier stripped, so a REAL room that merely sits in an
  // area — "Holzsteg (Dijala)" — is not mistaken for a bridge into #Dijala.
  const resolve = (n: GNode): GNode => {
    if (!n.name) return n;
    const base = deumlaut(n.name).replace(/\s*\(.*$/, "");
    for (const a of n.anchors ?? []) {
      const gi = groupGi(a);
      if (gi >= 0 && gi !== n.gi && base.includes(deumlaut(a))) return primaryOf(gi) ?? n;
    }
    return n;
  };
  // Score every candidate by match strength, then prefer the primary room on a
  // tie: a numbered room (real, e.g. "9 Marktplatz (Marktschreier)") beats a
  // letter-labelled cross-reference to the same place on another sub-map ("K
  // Marktplatz"), and an earlier/main sub-map beats a later one. Exact full-name
  // and exact base-name (parenthetical stripped) share the top name tier so
  // "Marktplatz" matches "Marktplatz (Marktschreier)" as strongly as a bare
  // "Marktplatz" — letting the numbered-primary tie-break decide.
  // Same-label neighbours: a room drawn across several map cells (e.g. the 2×2
  // "9" Marktplatz block) has cells that border each other, whereas a stray/
  // erroneous lone duplicate of the number does not. Preferring the clustered
  // cell lands the endpoint on the real room, not the misplaced glyph.
  const sameLabelNeighbours = (n: GNode): number => {
    if (!n.label) return 0;
    let k = 0;
    for (const e of adj.get(n.gid) ?? []) if (nodes.get(e.to)?.label === n.label) k++;
    return k;
  };
  // Separator-insensitive name compare: collapse any punctuation/space run to a
  // single space so a query "Nurikomoon-Tempel" matches a room "Nurikomoon
  // Tempel (Nuriko)". (Labels are single glyphs — compared raw, via `ql`.)
  // Coordinate-addressed entry ("Rand@66,0"): pin the EXACT node, so a synthesized
  // overworld entrance can enter one specific edge room among several identically
  // named ones ("Rand"). Falls through to name matching if no node sits there.
  const coord = /@(\d+),(\d+)\s*$/.exec(q);
  if (coord) {
    const [pr, pc] = [+coord[1], +coord[2]];
    for (const n of nodes.values()) if (n.r === pr && n.c === pc) return n;
  }
  const sep = (s: string) => deumlaut(s).replace(/[^a-z0-9]+/g, " ").trim();
  const nq = sep(q.replace(/@\d+,\d+\s*$/, ""));
  const base = (s: string) => sep(deumlaut(s).replace(/\s*\(.*$/, ""));
  let best: GNode | null = null, bestScore = -1;
  for (const n of nodes.values()) {
    let tier = -1;
    if (n.label && n.label.toLowerCase() === ql) tier = 4;
    else if (n.name && (sep(n.name) === nq || base(n.name) === nq)) tier = 3;
    // A sub-map anchor the room carries (e.g. room 13's "#Trabantenstadt") is an
    // alternate name for that room — ranked below a real name match but above a
    // loose substring, so "Trabantenstadt" resolves to the room, not a stray hit.
    else if (n.anchors && n.anchors.some((a) => sep(a.replace(/_/g, " ")) === nq)) tier = 2;
    else if (n.name && sep(n.name).includes(nq)) tier = 1;
    if (tier < 0) continue;
    const numbered = n.label && /^\d+$/.test(n.label) ? 1 : 0;
    // Co-location bias: when the caller has already pinned the OTHER endpoint to a
    // sub-map, prefer a same-name candidate on that map. Weighted below the name
    // tier / numbered-primary signals (so it only breaks what the `1/(1+gi)` group
    // order would otherwise decide) — this is what lets drachenberge's "Steg der
    // Moaki-Bucht" resolve to the Klosterberg sub-map that also holds the Tempel,
    // instead of the identically-named Steg on the overview Karte.
    const colocated = preferGi >= 0 && n.gi === preferGi ? 1 : 0;
    const score = tier * 1e6 + numbered * 1e4 + colocated * 1e3 + sameLabelNeighbours(n) * 100 + 1 / (1 + n.gi);
    if (score > bestScore) { bestScore = score; best = n; }
  }
  return best ? resolve(best) : null;
}

/** Recover the wire cells connecting two graph-adjacent nodes on a grid, by a
 *  shortest-cell BFS that leaves a node in any direction onto a wire, then
 *  follows wires (per `wireDirs`) until it reaches the other node's span. */
function traceCells(grid: string[][], a: GNode, b: GNode): string[] {
  const H = grid.length, Wd = grid[0]?.length ?? 0;
  const at = (r: number, c: number) => (r >= 0 && r < H && c >= 0 && c < Wd ? grid[r][c] : " ");
  const goal = new Set<string>();
  for (let c = b.c; c <= (b.cEnd ?? b.c); c++) goal.add(`${b.r},${c}`);
  const prev = new Map<string, string | null>();
  const q: [number, number, boolean][] = [];
  for (let c = a.c; c <= (a.cEnd ?? a.c); c++) { const k = `${a.r},${c}`; if (!prev.has(k)) { prev.set(k, null); q.push([a.r, c, true]); } }
  while (q.length) {
    const [r, c, onNode] = q.shift()!;
    const k = `${r},${c}`;
    if (goal.has(k)) { const out: string[] = []; let cur: string | null = k; while (cur) { out.push(cur); cur = prev.get(cur) ?? null; } return out; }
    // From a node cell we may set off in any direction onto a wire; once on a
    // wire we follow only where that wire glyph leads.
    for (const wd of onNode ? Object.keys(OFF) : wireDirs(at(r, c))) {
      const [dr, dc] = OFF[wd], nr = r + dr, nc = c + dc, nk = `${nr},${nc}`;
      if (prev.has(nk)) continue;
      if (goal.has(nk) || wireDirs(at(nr, nc)).length > 0) { prev.set(nk, k); q.push([nr, nc, goal.has(nk)]); }
    }
  }
  return [];
}

/** Render ONLY the cells the route actually traverses (wires + node labels),
 *  blanking everything else, cropped per sub-map to the path's bounding box.
 *  So the snippet shows the referenced part of the map, not the whole quarter. */
function asciiPath(grids: string[][][], nodes: Map<string, GNode>, pathGids: string[]): string {
  const seq = pathGids.map((g) => nodes.get(g)!);
  const keep = new Map<number, Set<string>>(); // gi → "r,c" cells on the route
  const add = (gi: number, r: number, c: number) => (keep.get(gi) ?? keep.set(gi, new Set()).get(gi)!).add(`${r},${c}`);
  for (const n of seq) for (let c = n.c; c <= (n.cEnd ?? n.c); c++) add(n.gi, n.r, c); // node labels
  // Sub-map transitions: the two halves of the route live on separate maps and
  // are joined where one's exit node IS the other's entry node. Record those
  // pairs so the gap between rendered blocks can name the crossing explicitly
  // (otherwise a bare "…" hides that e.g. the city's Osttor = the harbour entry).
  const trans = new Map<string, { from: GNode; to: GNode }>();
  for (let i = 1; i < seq.length; i++) {
    const a = seq[i - 1], b = seq[i];
    if (a.gi !== b.gi) { trans.set(`${a.gi}>${b.gi}`, { from: a, to: b }); continue; }
    for (const cell of traceCells(grids[a.gi], a, b)) { const [r, c] = cell.split(",").map(Number); add(a.gi, r, c); }
  }
  const renderBlock = (gi: number, cells: Set<string>) => {
    const grid = grids[gi];
    const rc = [...cells].map((k) => k.split(",").map(Number));
    const r0 = Math.min(...rc.map((p) => p[0])), r1 = Math.max(...rc.map((p) => p[0]));
    const c0 = Math.min(...rc.map((p) => p[1])), c1 = Math.max(...rc.map((p) => p[1]));
    const rows: string[] = [];
    for (let r = r0; r <= r1; r++) {
      let row = "";
      for (let c = c0; c <= c1; c++) row += cells.has(`${r},${c}`) ? grid[r][c] : " ";
      rows.push(row.replace(/\s+$/, ""));
    }
    return rows.join("\n");
  };
  // Emit blocks in path order, naming each crossing between them.
  const order = [...new Set(seq.map((n) => n.gi))].filter((gi) => (keep.get(gi)?.size ?? 0) >= 2);
  const out: string[] = [];
  for (let k = 0; k < order.length; k++) {
    if (k > 0) {
      const t = trans.get(`${order[k - 1]}>${order[k]}`);
      out.push(t
        ? `        ┆\n   ╰─ Übergang durch »${t.from.label ?? "?"}« (${t.from.name ?? "?"}) ───▶ »${t.to.label ?? "?"}« (${t.to.name ?? "?"}) im nächsten Teilplan:\n        ┆`
        : "…");
    }
    out.push(renderBlock(order[k], keep.get(order[k])!));
  }
  return out.join("\n");
}

/** Compute a route between two room names/labels on a single area page.
 *  `climbHints` (optional, keyed by node gid) lets the caller enrich a HIDDEN
 *  step leaving that node with a clarification from the merged marcopolo graph —
 *  e.g. wiki "14 Lawinengefahr"'s unclear `'`/dot exit is really a "kletter
 *  runter". Annotation only: it never changes the path. See [[marcopolo-secondary-maps]]. */
export function routeOnPage(md: string, fromQ: string, toQ: string, climbHints?: Map<string, string>): RouteResult {
  const conn = connectorGlyphs(md);
  const groups = splitGroups(md, conn);
  if (!groups.length) return { ok: false, error: "keine Karte auf dieser Seite" };
  const { nodes, adj, grids } = buildGraph(groups, conn);
  const anchors = groups.map((g) => g.anchor);
  let s = findNode(nodes, adj, fromQ, anchors), t = findNode(nodes, adj, toQ, anchors);
  if (!s || !t) return { ok: false, error: `Raum nicht auf der Karte gefunden: ${!s ? fromQ : toQ}` };
  // Endpoint co-location: a room name can recur across sub-maps of one page (e.g.
  // "Steg der Moaki-Bucht" on both the drachenberge overview and the Klosterberg
  // detail). When the two endpoints land on different sub-maps, re-resolve each
  // biased toward the OTHER's sub-map and keep a co-located pairing if one exists —
  // so an intra-map route isn't split across the wrong same-named tiles. Only
  // moves an endpoint when an equally-good same-name candidate sits on the other's
  // map, so genuinely cross-sub-map routes (bridged by anchors) are untouched.
  if (s.gi !== t.gi) {
    const s2 = findNode(nodes, adj, fromQ, anchors, t.gi);
    const t2 = findNode(nodes, adj, toQ, anchors, s.gi);
    if (s2 && s2.gi === t.gi) s = s2;
    else if (t2 && t2.gi === s.gi) t = t2;
  }
  // Dijkstra: a sub-map transition is a real (≈1) move but slightly penalized
  // so that when a comparable in-map path exists it wins — without forcing a
  // long detour to avoid a crossing that is genuinely the shortest way.
  const cost = (e: any) => (e.transition ? 3 : 1);
  const prev = new Map<string, { from: string; e: any } | null>([[s.gid, null]]);
  const dist = new Map<string, number>([[s.gid, 0]]);
  const done = new Set<string>();
  const pq = [s.gid];
  while (pq.length) {
    let bi = 0; for (let k = 1; k < pq.length; k++) if ((dist.get(pq[k]) ?? Infinity) < (dist.get(pq[bi]) ?? Infinity)) bi = k;
    const cur = pq.splice(bi, 1)[0];
    if (done.has(cur)) continue; done.add(cur);
    if (cur === t.gid) break;
    for (const e of adj.get(cur) ?? []) {
      const nd = (dist.get(cur) ?? Infinity) + cost(e);
      if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, { from: cur, e }); pq.push(e.to); }
    }
  }
  if (!prev.has(t.gid)) return { ok: false, error: "kein zusammenhängender Weg in den Karten gefunden" };
  const raw: RouteStep[] = []; const pathGids = [t.gid]; let cur = t.gid;
  while (prev.get(cur)) { const { from, e } = prev.get(cur)!; raw.unshift({ dir: e.dir, hidden: e.hidden, transition: e.transition, toName: nodes.get(e.to)?.name ?? null, hint: e.hidden ? climbHints?.get(from) ?? null : null }); pathGids.unshift(from); cur = from; }
  // A sub-map crossing (`transition`, dir=null) is a map overlay, not a separate
  // action — fold its note onto the next real walk step (else the previous one) so it
  // rides on a normal move instead of being a directionless step of its own.
  const steps: RouteStep[] = []; let pendingSeam: string | null = null;
  for (const st of raw) {
    if (!st.dir && st.transition) { pendingSeam = pendingSeam ? `${pendingSeam}; ${st.transition}` : st.transition; continue; }
    steps.push(pendingSeam && !st.transition ? { ...st, transition: pendingSeam } : st);
    pendingSeam = null;
  }
  if (pendingSeam) {
    if (steps.length && !steps[steps.length - 1].transition) steps[steps.length - 1] = { ...steps[steps.length - 1], transition: pendingSeam };
    else steps.push({ dir: null, hidden: false, transition: pendingSeam, toName: null });
  }
  // A map-overlay crossing is not a user action, so it no longer disqualifies a
  // "clear" route: clear = every step is a real move (or a bare overlay marker) and
  // none is a hidden/unreadable move.
  const clear = steps.every((x) => !x.hidden && (x.dir || x.transition));
  return { ok: true, from: s.name ?? s.label ?? fromQ, to: t.name ?? t.label ?? toQ, steps, clear, ascii: asciiPath(grids, nodes, pathGids) };
}

/**
 * Emit this page's parsed map as unified-graph IR (nodes + command-edges), the
 * same shape the marcopolo side produces, so the two can be merged into one
 * `_navgraph` artifact. A wiki edge's command is its compass/z direction unless
 * the move is hidden (`'`/dot → command unknown); a hidden ˄/˅ still yields a
 * climb HINT. Cross-map transitions are edges flagged `transition`. Anonymous
 * junction `o` nodes are kept (routing needs them) but carry a null name.
 */
export function pageGraphIR(md: string, pageSlug: string, region: string): { nodes: NavNode[]; edges: NavEdge[] } {
  const conn = connectorGlyphs(md);
  const groups = splitGroups(md, conn);
  if (!groups.length) return { nodes: [], edges: [] };
  const { nodes, adj } = buildGraph(groups, conn);
  const idOf = (gid: string) => `wiki:${pageSlug}#${gid}`;
  const norm = (s: string) => deumlaut(s).replace(/[^a-z0-9]+/g, "");
  // A room's gateway targets: its legend #sub-map anchors PLUS the KB pages its
  // legend line links to (from pageLinks). Both feed structural reconciliation.
  const linkTargets = new Map<string, string[]>();
  for (const pl of pageLinks(md)) linkTargets.set(pl.label, pl.targets);
  const outNodes: NavNode[] = [];
  for (const n of nodes.values()) {
    const portals = [
      ...(n.anchors ?? []),
      ...(n.label ? linkTargets.get(n.label) ?? [] : []),
    ].map(norm).filter(Boolean);
    outNodes.push({
      id: idOf(n.gid),
      name: n.name,
      aliases: [],
      region,
      sources: [{ origin: "wiki", page: pageSlug, label: n.label ?? "" }],
      ...(portals.length ? { portals: [...new Set(portals)] } : {}),
    });
  }
  const edges: NavEdge[] = [];
  for (const [gid, list] of adj as Map<string, { to: string; dir: string | null; hidden: boolean; transition: string | null }[]>) {
    for (const e of list) {
      // A plain ˄/˅ (not hidden) is a stair-like "hoch"/"runter" command — NOT a
      // climb. Only a HIDDEN move (`'`/dot on the path) has an unknown command;
      // there a ˄/˅ still gives an up/down HINT, phrased as uncertain (it may be
      // a climb or a fully custom verb — we cannot know).
      const command = !e.hidden && e.dir && !e.transition ? e.dir : null;
      const hint = e.transition || !e.hidden ? null
        : e.dir === "hoch" ? "nach oben – Befehl unklar (evtl. klettern/Sonderbefehl)"
        : e.dir === "runter" ? "nach unten – Befehl unklar (evtl. klettern/Sonderbefehl)"
        : null;
      edges.push(edge(idOf(gid), idOf(e.to), command, "wiki", pageSlug, { hint, transition: !!e.transition }));
    }
  }
  return { nodes: outNodes, edges };
}

/** Each ASCII sub-map on a page, with its heading anchor, legend and raw art —
 *  for answering "zeig mir die Karte vom <Gebiet>" by surfacing one sub-map. */
export interface PageMap { anchor: string; rooms: string[]; legend: [string, string][]; anchors: [string, string[]][]; ascii: string }
export function pageMaps(md: string): PageMap[] {
  return splitGroups(md)
    .map((g) => ({
      anchor: g.anchor,
      rooms: [...g.labelName.values()],
      legend: [...g.labelName.entries()] as [string, string][],
      anchors: [...g.labelAnchor.entries()] as [string, string[]][],
      ascii: g.mapLines.join("\n").replace(/[ \t]+$/gm, "").replace(/\n+$/, ""),
    }))
    .filter((m) => m.ascii.trim().length > 0);
}

/** A legend gateway room and the KB map pages it links to (raw slugs, no ".md"),
 *  e.g. Tadmor's "W Westtor" → ["handelsweg-borsippa", "borsippa"]. Used to build
 *  the cross-page graph so a route can span several ASCII maps. */
export interface PageLink { label: string; name: string; targets: string[]; }
export function pageLinks(md: string): PageLink[] {
  const out: PageLink[] = [];
  const rowRe = /^\s*([0-9]{1,3}|[A-Z]{1,2}[0-9]?|~)\s+(\S.*)$/;
  // Pull every "](/some/page.md …)" target out of a legend line.
  const grab = (text: string, set: Set<string>) => {
    for (const m of text.matchAll(/\]\((\/[^)\s]+?)\.md[^)]*\)/g))
      set.add(decodeURIComponent(m[1]).replace(/^\/+/, ""));
  };
  let cur: { label: string; name: string; set: Set<string> } | null = null;
  const flush = () => { if (cur && cur.set.size) out.push({ label: cur.label, name: cur.name, targets: [...cur.set] }); cur = null; };
  for (const ln of md.split("\n")) {
    const m = rowRe.exec(ln);
    if (m) {
      flush();
      const set = new Set<string>(); grab(m[2], set);
      cur = { label: m[1], name: cleanName(m[2]), set };
    } else if (cur && /^\s*[([]/.test(ln)) {
      grab(ln, cur.set); // parenthetical continuation of the previous legend row
    } else if (ln.trim() === "") {
      continue; // blank line: keep the current row open (legends have blank gaps)
    } else {
      flush();
    }
  }
  flush();
  return out;
}

/** A sub-map's entrance room: a labelled room whose legend links BACK to the
 *  region overworld ("1 Rand → /gallien.md"), i.e. an edge where you can leave the
 *  area onto the overworld. Classified onto a side of its sub-map's bounding box
 *  and ordered along it, so it can be matched to a marcopolo/overworld entrance by
 *  (side, ordinal). See [[overworld-ascii-entrance-seam]]. */
export interface SubMapEntrance {
  group: number; anchor: string; label: string; name: string | null;
  r: number; c: number; side: "N" | "E" | "S" | "W"; ordinal: number;
}
export function subMapEntrances(md: string, regionSlug: string): SubMapEntrance[] {
  const conn = connectorGlyphs(md);
  const groups = splitGroups(md, conn);
  if (!groups.length) return [];
  const { nodes } = buildGraph(groups, conn);
  // A label like "1" is reused per sub-map (main map: "1 Rand"→region; the
  // Trabantenstadt sub-map: "1 Kellergeschoss"), so key the entrance on BOTH the
  // label AND its region-linked name to avoid catching a same-labelled interior
  // room on another sub-map.
  const key = (label: string, name: string | null) => `${label}\t${deumlaut(name ?? "")}`;
  const entranceKeys = new Set(
    pageLinks(md).filter((l) => l.targets.includes(regionSlug)).map((l) => key(l.label, l.name)),
  );
  if (!entranceKeys.size) return [];
  const byGroup = new Map<number, GNode[]>();
  for (const n of nodes.values()) (byGroup.get(n.gi) ?? byGroup.set(n.gi, []).get(n.gi)!).push(n);
  const out: SubMapEntrance[] = [];
  for (const [gi, gnodes] of byGroup) {
    const ent = gnodes.filter((n) => n.label && entranceKeys.has(key(n.label, n.name)));
    if (!ent.length) continue;
    // Bounding box of the WHOLE sub-map (all nodes), so an entrance is placed
    // relative to the real map extent, not just the entrance cluster.
    const rmin = Math.min(...gnodes.map((n) => n.r)), rmax = Math.max(...gnodes.map((n) => n.r));
    const cmin = Math.min(...gnodes.map((n) => n.c)), cmax = Math.max(...gnodes.map((n) => n.c));
    const sideOf = (r: number, c: number): SubMapEntrance["side"] => {
      const dN = r - rmin, dS = rmax - r, dW = c - cmin, dE = cmax - c;
      const min = Math.min(dN, dS, dW, dE);
      return dN === min ? "N" : dS === min ? "S" : dW === min ? "W" : "E";
    };
    const rows = ent.map((n) => ({ n, side: sideOf(n.r, n.c) }));
    for (const s of ["N", "E", "S", "W"] as const) {
      const grp = rows.filter((x) => x.side === s)
        .sort((a, b) => (s === "N" || s === "S" ? a.n.c - b.n.c : a.n.r - b.n.r));
      grp.forEach(({ n }, i) => out.push({
        group: gi, anchor: groups[gi]?.anchor ?? "", label: n.label!, name: n.name,
        r: n.r, c: n.c, side: s, ordinal: i,
      }));
    }
  }
  return out;
}

/** List the labelled rooms on a page (for the nav room index). Sub-map anchors a
 *  room links to (e.g. room 13's "[Ruine](#Trabantenstadt)") are alternate names
 *  for that same room, so they are emitted as aliases — this lets a query for the
 *  anchor ("Trabantenstadt") surface the page and resolve to the room carrying it
 *  (the worldmap overlap anchors "#Karte"/"#toc" are structural, not room names). */
export function listRooms(md: string): { name: string; label: string }[] {
  const out: { name: string; label: string }[] = [];
  for (const g of splitGroups(md)) {
    for (const [label, name] of g.labelName) if (name) out.push({ name, label });
    for (const [label, anchors] of g.labelAnchor)
      for (const a of anchors) {
        const alias = cleanName(a.replace(/_/g, " "));
        if (alias && !/^(karte|toc)$/i.test(alias)) out.push({ name: alias, label });
      }
  }
  return out;
}

/** Format a computed route for injection into the model context. One continuous
 *  numbered list across all maps (transitions are their own numbered lines);
 *  runs of the same direction collapse into a numbered range with an explicit
 *  count, so totals like "18× westen" are countable at a glance instead of
 *  hidden in a comma stream or split into per-map blocks. */
export function formatRoute(r: RouteResult): string {
  if (!r.ok) return "";
  const steps = r.steps!;
  const w = String(steps.length).length; // number-column width
  const pad = (n: number) => String(n).padStart(w);
  // A hidden step ran through a "'"/dot — "no recognizable direction" per the
  // legend — so its COMMAND is unknown (you must tüfteln), and the geometric
  // compass guess is misleading. A ˄/˅ arrow on the path still yields a reliable
  // up/down HINT (dir = hoch/runter), so keep that as context while flagging the
  // command unknown; otherwise the direction is fully unknown.
  const stepLabel = (s: RouteStep): string => {
    if (!s.hidden) return s.dir!;
    // A `'`/dotted hidden move carries NO direction — its compass label is pure
    // geometry and misleading — so never show it. Only a ˄/˅ move conveys a real
    // hoch/runter. Prefer the marcopolo clarification when present.
    const vertical = s.dir === "hoch" || s.dir === "runter";
    if (s.hint) return vertical ? `${s.dir} – ${s.hint} (Wiki-Karte unklar)` : `${s.hint} (Wiki-Karte unklar)`;
    if (s.dir === "hoch") return "hoch (aber Befehl unklar – evtl. »klettere hoch« o. Ä., tüfteln)";
    if (s.dir === "runter") return "runter (aber Befehl unklar – tüfteln)";
    return "??? unklarer Weg – Richtung nicht ablesbar, hier tüfteln";
  };
  const seam = (t: string) => t.replace(/^Übergang nach\s+/i, "");
  const lines: string[] = [];
  let i = 0, n = 0;
  while (i < steps.length) {
    const s = steps[i];
    // A pure overlay marker (no direction): you just keep walking onto the next
    // map — un-numbered context, not a counted action.
    if (!s.dir) {
      if (s.transition) lines.push(`${" ".repeat(w + 1)}↳ (Karte wechselt zu ${seam(s.transition)} – einfach weiterlaufen)`);
      i += 1;
      continue;
    }
    const label = stepLabel(s);
    // A real move that ALSO crosses a map seam: a normal counted step with the
    // crossing noted inline (still just one walk — you don't type anything extra).
    if (s.transition) {
      lines.push(`${pad(n + 1)}. ${label}  ⟶ (dabei Karte wechseln zu ${seam(s.transition)}, einfach weiterlaufen)`);
      n += 1; i += 1;
      continue;
    }
    // Collapse a run of identical, un-annotated directional steps.
    let j = i;
    while (j < steps.length && steps[j].dir && !steps[j].transition && stepLabel(steps[j]) === label) j += 1;
    const count = j - i;
    if (count === 1) lines.push(`${pad(n + 1)}. ${label}`);
    else lines.push(`${pad(n + 1)}–${pad(n + count)}. ${label} (${count}×)`);
    n += count;
    i = j;
  }
  const moves = n;
  let out = `BERECHNETER WEG von „${r.from}" nach „${r.to}" (${moves} Laufschritte, deterministisch aus der Karte, NICHT verändern):\n`;
  out += lines.join("\n");
  if (r.clear) out += `\n\nKopierbarer Befehl: tue ${steps.filter((s) => s.dir).map((s) => s.dir).join(", ")}`;
  else out += `\n\n(Enthält nicht-offensichtliche Stellen oder Kartenübergänge – kein einzelner kopierbarer Befehl möglich.)`;
  if (r.ascii) out += `\n\nKartenausschnitt des Weges:\n\`\`\`\n${r.ascii}\n\`\`\``;
  return out;
}

/** Water/terrain name fragments — a node whose name matches these should be a
 *  dead-end tile you step onto, NOT a through-corridor. If such a node has a
 *  high degree it's usually a crossing the parser wrongly wired through. */
const WATER_RE = /bach|fluss|ufer|dijala|graben|bucht|passage|kanal|see|teich|wasser|moat|steg|furt|brücke|bruecke/i;

export interface PageDiagnostics {
  groups: number;
  nodes: number;
  namedNodes: number;
  edges: number;          // undirected edge count
  hiddenEdges: number;    // edges the tracer couldn't assign a compass dir
  isolated: number;       // nodes with no edges at all
  components: number;     // connected components (fragmentation signal)
  maxDegree: number;
  maxDegreeName: string | null;
  waterThrough: { name: string; label: string | null; degree: number }[]; // suspected crossing misparses
  suspicion: number;      // heuristic rank score, higher = look here first
}

/** Build the graph for a page and report structural health signals, without
 *  routing. Used by the offline audit to rank "most suspicious" maps so the
 *  crossing-heuristic's real failure rate can be measured, not guessed. */
export function diagnosePage(md: string): PageDiagnostics | null {
  const conn = connectorGlyphs(md);
  const groups = splitGroups(md, conn);
  if (!groups.length) return null;
  const { nodes, adj } = buildGraph(groups, conn);
  const ids = [...nodes.keys()];

  // Undirected edge set + degree per node.
  const undirected = new Set<string>();
  const degree = new Map<string, number>();
  let hiddenEdges = 0;
  for (const id of ids) {
    for (const e of adj.get(id) ?? []) {
      const key = id < e.to ? `${id}|${e.to}` : `${e.to}|${id}`;
      if (!undirected.has(key)) { undirected.add(key); if (e.hidden) hiddenEdges++; }
      degree.set(id, (degree.get(id) ?? 0) + 1);
    }
  }

  // Connected components over the undirected graph.
  const seen = new Set<string>();
  let components = 0;
  const neighbors = (id: string) => (adj.get(id) ?? []).map((e) => e.to);
  for (const id of ids) {
    if (seen.has(id)) continue;
    components++;
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const nb of neighbors(cur)) if (!seen.has(nb)) stack.push(nb);
    }
  }

  let maxDegree = 0, maxDegreeName: string | null = null;
  const waterThrough: PageDiagnostics["waterThrough"] = [];
  for (const id of ids) {
    const n = nodes.get(id)!;
    const d = degree.get(id) ?? 0;
    if (d > maxDegree) { maxDegree = d; maxDegreeName = n.name ?? n.label; }
    if (d > 2 && n.name && WATER_RE.test(n.name)) waterThrough.push({ name: n.name, label: n.label, degree: d });
  }

  const isolated = ids.filter((id) => (degree.get(id) ?? 0) === 0).length;
  const namedNodes = ids.filter((id) => nodes.get(id)!.name).length;
  // Rank: crossing-misparse signals dominate, then dead nodes and fragmentation.
  const suspicion =
    waterThrough.reduce((s, w) => s + w.degree, 0) * 4 +
    hiddenEdges * 2 +
    isolated * 3 +
    Math.max(0, components - 1) * 2 +
    Math.max(0, maxDegree - 4);

  return {
    groups: groups.length,
    nodes: nodes.size,
    namedNodes,
    edges: undirected.size,
    hiddenEdges,
    isolated,
    components,
    maxDegree,
    maxDegreeName,
    waterThrough,
    suspicion,
  };
}
