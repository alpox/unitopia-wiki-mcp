/**
 * Merge per-page IR graphs into one region `UnifiedGraph`. The wiki side is
 * authoritative and kept verbatim (priority 1); the marcopolo side is layered on
 * as priority-2 FALLBACK edges, attached to wiki rooms by region + name so its
 * connectivity fills gaps the wiki map leaves — without ever overriding a wiki
 * edge. See [[marcopolo-secondary-maps]].
 *
 * Reconciliation rule: a marcopolo node is identified with a wiki node when they
 * share a region and a normalized name. marcopolo splits an area into several
 * same-named sub-tiles (e.g. four "Bach" cells); those collapse to one
 * representative and bind to the single wiki room of that name — exactly the
 * coarse fallback we want. Marcopolo nodes with no wiki match survive as new
 * reachable places. A marcopolo edge is dropped if a wiki edge already joins the
 * same (from,to) pair.
 */
import { deumlaut, roomTokens, tokenOverlap } from "../mapGraph.js";
import type { NavEdge, NavNode, UnifiedGraph, Origin } from "./types.js";

export interface GraphPart {
  nodes: NavNode[];
  edges: NavEdge[];
}

// Reconciliation key: base name with any trailing "(qualifier)" stripped, so the
// wiki's "Bach (Strömung!)" binds to marcopolo's "Bach". Parenthetical qualifiers
// name occupants/features, not distinct rooms, for this coarse fallback layer.
const norm = (name: string | null) =>
  name ? deumlaut(name.replace(/\s*\(.*$/, "")).replace(/[^a-z0-9]+/g, " ").trim() : "";

export function mergeGraphs(region: string, wiki: GraphPart[], marco: GraphPart[]): UnifiedGraph {
  const wikiNodes = wiki.flatMap((p) => p.nodes);
  const wikiEdges = wiki.flatMap((p) => p.edges);
  const marcoNodes = marco.flatMap((p) => p.nodes);
  const marcoEdges = marco.flatMap((p) => p.edges);

  // Wiki lookup tables. STRUCTURAL first: a gateway target ("drachenkopf") → the
  // wiki room that leads there. Then by name as a fallback.
  const wikiByPortal = new Map<string, string>();
  for (const n of wikiNodes) for (const p of n.portals ?? []) if (!wikiByPortal.has(p)) wikiByPortal.set(p, n.id);
  // A normalized name is only a usable bind key when it identifies ONE wiki ROOM.
  // When several distinct rooms share it (e.g. Vaniorh's separate "Handelsweg"
  // tiles), picking the first is arbitrary and welds marcopolo connectivity onto
  // the wrong room, inventing false shortcuts. Such ambiguous names are excluded
  // from name-binding — those marcopolo nodes stay synthetic (or bind via portal).
  // A room is (page, sub-map group, label): one room may be DRAWN as several
  // cells (distinct node ids) — those collapse here, so a multi-cell room like
  // "Bach" is NOT ambiguous, but two differently-labelled tiles are.
  const roomKey = (n: NavNode) => `${n.sources[0]?.page}#${n.id.slice(n.id.indexOf("#") + 1).split(":")[0]}#${n.sources[0]?.label}`;
  const wikiRoomsByName = new Map<string, Set<string>>();
  for (const n of wikiNodes) if (n.name) (wikiRoomsByName.get(norm(n.name)) ?? wikiRoomsByName.set(norm(n.name), new Set()).get(norm(n.name))!).add(roomKey(n));
  const wikiByName = new Map<string, string>();
  for (const n of wikiNodes) if (n.name && wikiRoomsByName.get(norm(n.name))!.size === 1 && !wikiByName.has(norm(n.name))) wikiByName.set(norm(n.name), n.id);

  // Resolve every marcopolo node id to its unified id. A marcopolo node binds to
  // a wiki node that shares a gateway target (structural, reliable) OR, failing
  // that, the same normalized name. marcopolo nodes of the same name (any page)
  // otherwise share one representative so the fallback graph is connected.
  const resolve = new Map<string, string>();
  const synthetic = new Map<string, NavNode>(); // unified id → marcopolo-only node
  for (const n of marcoNodes) {
    const viaPortal = (n.portals ?? []).map((p) => wikiByPortal.get(p)).find(Boolean);
    if (viaPortal) {
      resolve.set(n.id, viaPortal);
    } else if (n.name) {
      const key = norm(n.name);
      const wikiId = wikiByName.get(key);
      if (wikiId) {
        resolve.set(n.id, wikiId);
      } else {
        const synthId = `mc:${region.toLowerCase()}:${key.replace(/\s+/g, "-")}`;
        resolve.set(n.id, synthId);
        const cur = synthetic.get(synthId);
        if (cur) { cur.sources.push(...n.sources); if (n.portals) cur.portals = [...new Set([...(cur.portals ?? []), ...n.portals])]; }
        else synthetic.set(synthId, { id: synthId, name: n.name, aliases: [], region, sources: [...n.sources], ...(n.portals ? { portals: [...n.portals] } : {}) });
      }
    } else {
      resolve.set(n.id, n.id); // anonymous marcopolo junction: keep as-is
      if (!synthetic.has(n.id)) synthetic.set(n.id, { ...n, aliases: [...n.aliases] });
    }
  }

  // Graph-alignment pass (STRUCTURAL): bind a still-synthetic marcopolo room to
  // an unbound wiki room when they share ≥2 reconciled neighbours — a strong
  // 2-hop signal that they are the same place, catching rooms that name/portal
  // matching missed. Iterated to a fixpoint (each new bind can anchor the next).
  // It DEFAULTS to leaving a node synthetic — a miss is safer than a wrong weld —
  // so an under-anchored room (e.g. wiki "14 Handelsweg (Lawinengefahr!)", whose
  // only reconciled neighbour is Bach) is correctly NOT bound. See
  // [[marcopolo-secondary-maps]].
  const undirected = (edges: NavEdge[]) => {
    const a = new Map<string, Set<string>>();
    const add = (x: string, y: string) => (a.get(x) ?? a.set(x, new Set()).get(x)!).add(y);
    for (const e of edges) { add(e.from, e.to); add(e.to, e.from); }
    return a;
  };
  const wikiAdj = undirected(wikiEdges);
  const marcoAdj = undirected(marcoEdges);
  const wikiIds = new Set(wikiNodes.map((n) => n.id));
  const wikiName = new Map(wikiNodes.map((n) => [n.id, n.name]));
  const boundWiki = new Set<string>(); // wiki ids already claimed by a marcopolo room
  for (const uid of resolve.values()) if (wikiIds.has(uid)) boundWiki.add(uid);
  // Two NAMED rooms may only be welded by structure when their names also share a
  // token — structure alone must not fuse semantically-different rooms (e.g.
  // "Oststadtor" vs "Treppe nach Tadmor"). If either side is anonymous, the strong
  // structural signal decides on its own (both are just path/junction cells).
  const compatible = (m: NavNode, x: string): boolean => {
    const xn = wikiName.get(x);
    if (!m.name || !xn) return true;
    return tokenOverlap(roomTokens(m.name), xn);
  };
  // Wiki rooms grouped by normalized name (a room = several cells), for the
  // distinctive-token rule below.
  const roomsByName = new Map<string, { tokens: string[]; ids: string[] }>();
  for (const n of wikiNodes) if (n.name) {
    const nn = norm(n.name);
    const r = roomsByName.get(nn) ?? { tokens: roomTokens(n.name), ids: [] };
    r.ids.push(n.id); roomsByName.set(nn, r);
  }
  const rooms = [...roomsByName.values()];
  const prefixMatch = (a: string, b: string) => a === b || (a.length >= 5 && b.startsWith(a)) || (b.length >= 5 && a.startsWith(b));
  const boundRoom = (r: { ids: string[] }) => r.ids.some((id) => boundWiki.has(id));
  // A wiki room can be DRAWN as several cells (e.g. Bach "15--..--15"); an anchor's
  // neighbours must be taken over ALL its cells, else a node adjacent to a different
  // cell of the same room (the Felsterasse `o`, next to the far Bach cell) is missed.
  const wikiById2 = new Map(wikiNodes.map((n) => [n.id, n]));
  const cellKey = (n: NavNode) => (n.sources[0]?.label ? `${n.sources[0].page}#${n.sources[0].label}` : n.id);
  const cellsByRoom = new Map<string, string[]>();
  for (const n of wikiNodes) (cellsByRoom.get(cellKey(n)) ?? cellsByRoom.set(cellKey(n), []).get(cellKey(n))!).push(n.id);
  const roomCellsOf = (id: string) => { const n = wikiById2.get(id); return n ? cellsByRoom.get(cellKey(n)) ?? [id] : [id]; };
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const M of marcoNodes) {
      if (wikiIds.has(resolve.get(M.id)!)) continue; // already wiki-bound

      // Rule A — DISTINCTIVE TOKEN: a token of M's name that identifies exactly ONE
      // wiki room (rare word, e.g. "lawinen" ⊂ "lawinengefahr") binds M to that room
      // — but only if it's the sole UNBOUND such room. Common tokens ("borsippa",
      // matching many rooms) never qualify, and already-bound rooms (Bach,
      // Wasserfall) drop out — which is what leaves "14 Lawinengefahr" uniquely
      // identified for marco `L`. Structurally corroborated: [[marcopolo-secondary-maps]].
      if (M.name) {
        const matched = new Set<{ tokens: string[]; ids: string[] }>();
        for (const t of roomTokens(M.name)) {
          if (t.length < 5) continue; // only long, potentially-distinctive tokens
          const rs = rooms.filter((r) => r.tokens.some((b) => prefixMatch(t, b)));
          if (rs.length === 1) matched.add(rs[0]); // this token names exactly one wiki room
        }
        const cand = [...matched].filter((r) => !boundRoom(r));
        if (cand.length === 1) {
          const X = cand[0].ids[0];
          resolve.set(M.id, X); for (const id of cand[0].ids) boundWiki.add(id); changed = true;
          continue;
        }
      }

      // Rule B — STRUCTURAL: bind to an unbound wiki room that neighbours ≥2 of M's
      // reconciled marcopolo neighbours (with the compatible() name-token guard).
      const recNbrs = new Set<string>();
      for (const nb of marcoAdj.get(M.id) ?? []) { const u = resolve.get(nb); if (u && wikiIds.has(u)) recNbrs.add(u); }
      if (recNbrs.size < 2) continue;
      const score = new Map<string, number>(); // unbound wiki room → how many of recNbrs' ROOMS it neighbours
      for (const rn of recNbrs) {
        const nbrs = new Set<string>();
        for (const cell of roomCellsOf(rn)) for (const x of wikiAdj.get(cell) ?? []) nbrs.add(x);
        for (const x of nbrs) if (!boundWiki.has(x) && compatible(M, x)) score.set(x, (score.get(x) ?? 0) + 1);
      }
      const ranked = [...score.entries()].filter(([, s]) => s >= 2).sort((a, b) => b[1] - a[1]);
      if (!ranked.length || (ranked[1] && ranked[1][1] === ranked[0][1])) continue; // none, or an ambiguous tie
      const X = ranked[0][0];
      resolve.set(M.id, X); boundWiki.add(X); changed = true; // re-point just this room; a shared synthetic stays for its other same-name rooms
    }
    if (!changed) break;
  }

  // Record marcopolo source labels onto the wiki nodes they bound to.
  const wikiById = new Map(wikiNodes.map((n) => [n.id, n]));
  for (const n of marcoNodes) {
    const uid = resolve.get(n.id)!;
    const target = wikiById.get(uid);
    if (target) target.sources.push(...n.sources);
  }

  // Edges: wiki verbatim, then marcopolo remapped as fallback. A marcopolo edge
  // is dropped when the wiki ALREADY states a KNOWN command for that (from,to) —
  // wiki wins. But when the wiki edge is HIDDEN (command null: the wiki map marks
  // the move `'`/dot = "unknown"), a marcopolo edge that DOES name a command is
  // exactly the missing information, so it is kept as a clarification (priority 2,
  // the router can prefer it). New pairs are added as fallback connectivity.
  const edges: NavEdge[] = [...wikiEdges];
  const wikiCmd = new Map<string, string | null>();
  for (const e of wikiEdges) if (!wikiCmd.has(`${e.from}>${e.to}`)) wikiCmd.set(`${e.from}>${e.to}`, e.command);
  const added = new Set<string>();
  for (const e of marcoEdges) {
    const from = resolve.get(e.from)!, to = resolve.get(e.to)!;
    if (from === to) continue; // collapsed to same room
    const key = `${from}>${to}`;
    const wc = wikiCmd.get(key);
    if (wc !== undefined && wc !== null) continue; // wiki already knows this move
    if (wc === null && e.command === null && !e.hint) continue; // both unknown AND marcopolo adds no hint — nothing to add
    // (a marcopolo edge with a climb HINT for the same hidden wiki move IS worth
    //  keeping — it's what lets the route annotate e.g. "14 ·→ Felsterasse" as a
    //  kletter runter; see navIndex.ensureClimbHints)
    if (added.has(key) && wc === undefined) continue; // dedup marcopolo-only pairs
    added.add(key);
    edges.push({ ...e, from, to });
  }

  const nodes = [...wikiNodes, ...synthetic.values()];
  const builtFrom = groupPages([
    ...wikiNodes.flatMap((n) => n.sources),
    ...marcoNodes.flatMap((n) => n.sources),
  ]);
  return { region, nodes, edges, builtFrom };
}

function groupPages(sources: { origin: Origin; page: string }[]): { origin: Origin; pages: string[] }[] {
  const by = new Map<Origin, Set<string>>();
  for (const s of sources) (by.get(s.origin) ?? by.set(s.origin, new Set()).get(s.origin)!).add(s.page);
  return [...by.entries()].map(([origin, pages]) => ({ origin, pages: [...pages].sort() }));
}
