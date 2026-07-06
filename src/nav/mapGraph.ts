/**
 * Deterministic ASCII-map router for Unitopia area pages.
 *
 * Parses the ASCII maps + legends on a page into a room graph (wire-following
 * tracer that handles stretched/bent connectors and crossings), links sub-maps
 * via legend anchors, and computes shortest paths by BFS. Routes are computed
 * entirely in code — no LLM — so the assistant can never hallucinate a way.
 */

const BOX = "─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬";
// Underscore appears as map decoration on some maps (e.g. "\_'\_" diagonals on
// the Burg Tregyln map). It carries no direction, but it must be an allowed
// grid char or the row fails the whole-line class test and splits the map.
const CLS = new RegExp(`[\\s o~|/\\\\.'_\\-+0-9A-Z˄˅<>▼◄►▲${BOX}]`);
// A map row must contain at least one connector glyph (otherwise a row of pure
// labels/spaces would be mistaken for map art). Box-drawing chars count too:
// maps drawn with │─┌┼ often have corner-only rows ("┌┼┐", "┌┘ ' ˄") that carry
// no ASCII wire char — excluding them here fragments such maps (e.g. Burg
// Tregyln), scattering node markers away from their legend so rooms don't resolve.
const WIRECH = new RegExp(`[o~|/\\\\\\-${BOX}]`);
const isMapLine = (l: string) =>
  l.length > 4 && WIRECH.test(l) && !/\|\s*:?-{2,}:?\s*\|/.test(l) && [...l].every((c) => CLS.test(c));
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
export interface RouteStep { dir: string | null; hidden: boolean; transition: string | null; toName: string | null; }
export interface RouteResult {
  ok: boolean; from?: string; to?: string; steps?: RouteStep[];
  clear?: boolean; ascii?: string; error?: string;
}

const OFF: Record<string, [number, number]> = { E: [0, 1], W: [0, -1], N: [-1, 0], S: [1, 0], NE: [-1, 1], SW: [1, -1], NW: [-1, -1], SE: [1, 1] };
const COMPASS: Record<string, string> = { E: "osten", W: "westen", N: "norden", S: "sueden", NE: "nordosten", SW: "suedwesten", NW: "nordwesten", SE: "suedosten" };
const OPP: Record<string, string> = { E: "W", W: "E", N: "S", S: "N", NE: "SW", SW: "NE", NW: "SE", SE: "NW" };
const FLEX = ".'˄˅";
// Vertical (z-axis) portal glyphs: ˄ Hoch, ˅ Runter. A wire that runs through
// one is a climb/descent, not a compass move — labelled by travel direction.
const VERT = "˄˅";
const zLabel = (startDir: string, vert: boolean): string =>
  vert ? (startDir === "N" ? "hoch" : startDir === "S" ? "runter" : COMPASS[startDir]) : COMPASS[startDir];
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

function splitGroups(md: string): MapGroup[] {
  const lines = md.split("\n");
  const groups: MapGroup[] = [];
  let curHeading = "";
  let i = 0;
  while (i < lines.length) {
    const h = /^#{1,6}\s+\[?([^\]\n]+?)\]?(\(#?[^)]*\))?\s*$/.exec(lines[i]);
    if (h && !isMapLine(lines[i])) curHeading = anchorOf(h[1].replace(/\]\(.*$/, ""));
    if (isMapLine(lines[i])) {
      let start = i;
      // Pull in leading label-only rows that head the wires directly below them
      // (e.g. the "1     2" gate row atop Foo-Ling-Yoo's Stadtplan) — they carry
      // real node labels but no wire char, so isMapLine skips them otherwise.
      while (start > 0 && isLabelRow(lines[start - 1])) start--;
      while (i < lines.length && (isMapLine(lines[i]) || lines[i].trim() === "" ||
        (isLabelRow(lines[i]) && i > start && lines[i - 1].trim() !== "" && (isMapLine(lines[i - 1]) || isLabelRow(lines[i - 1]))) ||
        // A short "5--4"-style node-join row directly under existing map art.
        (isNodeJoinRow(lines[i]) && i > start && isMapLine(lines[i - 1])))) i++;
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
      while (j < lines.length && miss < 4 && !isMapLine(lines[j])) {
        const ln = lines[j];
        if (ln.trim() === "") { j++; continue; } // blank: neutral, keep legend context
        const m = /^\s*([0-9]{1,3}|[A-Z]{1,2}[0-9]?|~)\s+(\S.*)$/.exec(ln);
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

function buildGraph(groups: MapGroup[]) {
  const nodes = new Map<string, GNode>();
  const adj = new Map<string, { to: string; dir: string | null; hidden: boolean; transition: string | null }[]>();
  const groupNodes: string[][] = [];
  const grids: string[][][] = [];

  groups.forEach((g, gi) => {
    const W = Math.max(...g.mapLines.map((l) => l.length));
    const grid = g.mapLines.map((l) => l.padEnd(W, " ").split(""));
    grids[gi] = grid;
    const Hh = grid.length;
    const at = (r: number, c: number) => (r >= 0 && r < Hh && c >= 0 && c < W ? grid[r][c] : " ");
    const isNode = (ch: string) => ch === "o" || ch === "~" || /[A-Z]/.test(ch);
    const gid = (r: number, c: number) => `${gi}:${r},${c}`;
    const local: string[] = []; groupNodes[gi] = local;
    for (let r = 0; r < Hh; r++) for (let c = 0; c < W; c++) if (isNode(at(r, c))) {
      let lbl = /[A-Z]/.test(at(r, c)) ? at(r, c) : null;
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
    const nearVert = (r: number, c: number) =>
      VERT.includes(at(r, c)) || VERT.includes(at(r, c - 1)) || VERT.includes(at(r, c + 1)) ||
      VERT.includes(at(r - 1, c)) || VERT.includes(at(r + 1, c));
    for (const id of local) {
      const n = nodes.get(id)!;
      const ce = n.cEnd ?? n.c;
      const found = new Map<string, { dir: string; hidden: boolean }>();
      for (const startDir of Object.keys(OFF)) {
        const [sr, sc] = OFF[startDir];
        // Probe from the edge of the label span in the travel direction, so a
        // wire starting past a multi-char label ("47--o") is still reached.
        const fr = n.r + sr, fc = sc > 0 ? ce + 1 : sc < 0 ? n.c - 1 : n.c, fch = at(fr, fc);
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
        // 5th flag: the wire has crossed a ˄/˅ portal → this is a hoch/runter move.
        const q: [number, number, boolean, boolean, boolean][] = [[fr, fc, fch === "'", !FLEX.includes(fch) || nearVert(fr, fc), nearVert(fr, fc)]];
        while (q.length) {
          const [r, c, hasApos, hasDir, vert] = q.shift()!;
          for (const wd of wireDirs(at(r, c))) {
            const [dr, dc] = OFF[wd], nr = r + dr, nc = c + dc, nch = at(nr, nc);
            if (isNode(nch) || /[0-9]/.test(nch)) {
              if (underCrossed(nr, nc, wd)) {
                // pass under this node, continue straight in the same direction
                const ar = nr + dr, ac = nc + dc, akey = `${ar},${ac}`;
                if (!seen.has(akey) && wireDirs(at(ar, ac)).length) { seen.add(akey); q.push([ar, ac, hasApos, hasDir, vert]); }
                continue;
              }
              // A "'"/dot on the path makes the step's COMMAND unknown (the legend:
              // "keine erkennbare Himmelsrichtung"). A ˄/˅ portal only tells us the
              // room lies higher/lower — a useful hint (dir = hoch/runter) — but does
              // NOT clear `hidden`: you still can't just "hoch", you have to tüfteln
              // (a "klettere hoch"-type move). So keep hidden when hasApos/!hasDir.
              const t = nodeAt(nr, nc); if (t && t.gid !== id && !found.has(t.gid)) found.set(t.gid, { dir: zLabel(startDir, vert), hidden: hasApos || !hasDir }); continue;
            }
            const key = `${nr},${nc}`; if (seen.has(key)) continue;
            const nd = wireDirs(nch); if (nd.length === 0) continue;
            if (!FLEX.includes(nch) && !FLEX.includes(at(r, c)) && !nd.includes(OPP[wd])) continue;
            seen.add(key); q.push([nr, nc, hasApos || nch === "'", hasDir || !FLEX.includes(nch) || nearVert(nr, nc), vert || nearVert(nr, nc)]);
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
  for (const n of [...nodes.values()]) {
    for (const anchor of n.anchors ?? []) {
      if ((anchorUse.get(`${n.gi}:${anchor}`) ?? 0) > 3) continue; // terrain, not a gateway
      const tg = groups.findIndex((g) => g.anchor === anchor);
      if (tg < 0 || tg === n.gi) continue;
      for (const entry of entries(tg, groups[n.gi].anchor)) {
        if (!entry || entry === n.gid) continue;
        if (!adj.get(n.gid)!.some((x) => x.to === entry)) adj.get(n.gid)!.push({ to: entry, dir: null, hidden: false, transition: `Übergang nach ${nodes.get(entry)!.name ?? anchor}` });
        if (!adj.get(entry)!.some((x) => x.to === n.gid)) adj.get(entry)!.push({ to: n.gid, dir: null, hidden: false, transition: `Übergang nach ${n.name ?? groups[n.gi].anchor}` });
      }
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

function findNode(nodes: Map<string, GNode>, adj: Map<string, { to: string }[]>, q: string, groupAnchors: string[] = []): GNode | null {
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
  const sep = (s: string) => deumlaut(s).replace(/[^a-z0-9]+/g, " ").trim();
  const nq = sep(q);
  const base = (s: string) => sep(deumlaut(s).replace(/\s*\(.*$/, ""));
  let best: GNode | null = null, bestScore = -1;
  for (const n of nodes.values()) {
    let tier = -1;
    if (n.label && n.label.toLowerCase() === ql) tier = 4;
    else if (n.name && (sep(n.name) === nq || base(n.name) === nq)) tier = 3;
    else if (n.name && sep(n.name).includes(nq)) tier = 1;
    if (tier < 0) continue;
    const numbered = n.label && /^\d+$/.test(n.label) ? 1 : 0;
    const score = tier * 1e6 + numbered * 1e4 + sameLabelNeighbours(n) * 100 + 1 / (1 + n.gi);
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

/** Compute a route between two room names/labels on a single area page. */
export function routeOnPage(md: string, fromQ: string, toQ: string): RouteResult {
  const groups = splitGroups(md);
  if (!groups.length) return { ok: false, error: "keine Karte auf dieser Seite" };
  const { nodes, adj, grids } = buildGraph(groups);
  const anchors = groups.map((g) => g.anchor);
  const s = findNode(nodes, adj, fromQ, anchors), t = findNode(nodes, adj, toQ, anchors);
  if (!s || !t) return { ok: false, error: `Raum nicht auf der Karte gefunden: ${!s ? fromQ : toQ}` };
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
  const steps: RouteStep[] = []; const pathGids = [t.gid]; let cur = t.gid;
  while (prev.get(cur)) { const { from, e } = prev.get(cur)!; steps.unshift({ dir: e.dir, hidden: e.hidden, transition: e.transition, toName: nodes.get(e.to)?.name ?? null }); pathGids.unshift(from); cur = from; }
  const clear = steps.every((x) => x.dir && !x.hidden && !x.transition);
  return { ok: true, from: s.name ?? s.label ?? fromQ, to: t.name ?? t.label ?? toQ, steps, clear, ascii: asciiPath(grids, nodes, pathGids) };
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

/** List the labelled rooms on a page (for the nav room index). */
export function listRooms(md: string): { name: string; label: string }[] {
  const out: { name: string; label: string }[] = [];
  for (const g of splitGroups(md)) for (const [label, name] of g.labelName) if (name) out.push({ name, label });
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
    // A ˄/˅ gives the direction (hoch/runter); the "'" only means the exact
    // COMMAND is unclear — so lead with the direction, then flag it.
    if (s.dir === "hoch") return "hoch (aber Befehl unklar – evtl. »klettere hoch« o. Ä., tüfteln)";
    if (s.dir === "runter") return "runter (aber Befehl unklar – tüfteln)";
    return "??? unbekannte Richtung/Weg – hier suchen/tüfteln";
  };
  const lines: string[] = [];
  let i = 0, n = 0;
  while (i < steps.length) {
    const s = steps[i];
    if (s.transition) {
      // A map boundary is NOT an action — the player just keeps walking onto the
      // next map. Show it as an un-numbered context marker, not a counted step.
      const where = s.transition.replace(/^Übergang nach\s+/i, "");
      lines.push(`${" ".repeat(w + 1)}↳ (Karte wechselt zu ${where} – einfach weiterlaufen)`);
      i += 1;
      continue;
    }
    // Collapse a run of steps that render identically (same clean dir, or the
    // same kind of unknown/vertical hint).
    const label = stepLabel(s);
    let j = i;
    while (j < steps.length && !steps[j].transition && stepLabel(steps[j]) === label) j += 1;
    const count = j - i;
    if (count === 1) lines.push(`${pad(n + 1)}. ${label}`);
    else lines.push(`${pad(n + 1)}–${pad(n + count)}. ${label} (${count}×)`);
    n += count;
    i = j;
  }
  const moves = n;
  let out = `BERECHNETER WEG von „${r.from}" nach „${r.to}" (${moves} Laufschritte, deterministisch aus der Karte, NICHT verändern):\n`;
  out += lines.join("\n");
  if (r.clear) out += `\n\nKopierbarer Befehl: tue ${steps.map((s) => s.dir).join(" ")}`;
  else out += `\n\n(Enthält nicht-offensichtliche Stellen oder Kartenübergänge – kein einzelner kopierbarer Befehl möglich.)`;
  if (r.ascii) out += `\n\nKartenausschnitt des Weges:\n\`\`\`\n${r.ascii}\n\`\`\``;
  return out;
}

/** Water/terrain name fragments — a node whose name matches these should be a
 *  dead-end tile you step onto, NOT a through-corridor. If such a node has a
 *  high degree it's usually a crossing the parser wrongly wired through. */
const WATER_RE = /fluss|ufer|dijala|graben|bucht|passage|kanal|see|teich|wasser|moat|steg|furt|brücke|bruecke/i;

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
  const groups = splitGroups(md);
  if (!groups.length) return null;
  const { nodes, adj } = buildGraph(groups);
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
