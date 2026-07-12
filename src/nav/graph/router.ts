/**
 * Route over a merged region `UnifiedGraph` (wiki + marcopolo). Used ONLY as a
 * fallback, after the authoritative wiki router has failed, so it can add routes
 * the wiki maps can't complete but never override a working one. Wiki edges are
 * cheap (preferred); marcopolo fallback edges cost more but connect gaps. See
 * [[marcopolo-secondary-maps]].
 */
import { deumlaut, roomTokens, type RouteResult, type RouteStep } from "../mapGraph.js";
import type { NavEdge, NavNode, UnifiedGraph } from "./types.js";

const base = (s: string) => deumlaut(s).replace(/\s*\(.*$/, "").trim();

/**
 * Resolve a room query to a node id. Deliberately STRICT — this router is a
 * last-resort fallback that scans EVERY region graph, so a loose match here
 * fabricates a confident route between unrelated places (e.g. "Moaki-Bucht" →
 * "Bucht (Kurstafel)" in Gallien, "Tempel der BlueOrb" → a random "Tempel").
 *
 * Matching is TOKEN-based, not substring: an exact base-name wins, else EVERY
 * significant token of the query must appear as a token of the candidate room's
 * name (whole-token equality, or the room token being a MORE specific form of the
 * query token — "Tempel" query ⊂ "Tempelberg" room). Requiring *all* query tokens
 * is what stops a generic single word ("Bucht", "Tempel", "Felsen") from standing
 * in for a multi-word proper noun — the extra token ("moaki", "blueorb", "laksos")
 * has no home in the generic room, so it is rejected rather than routed. The match
 * never runs the other way (a garbage query token swallowing a short real token),
 * which would resurrect fabrication for nonsense queries. Wiki nodes win ties.
 */
function resolveNode(g: UnifiedGraph, q: string): NavNode | null {
  const nq = base(q);
  if (nq.length < 3) return null;
  const named = g.nodes.filter((n) => n.name);
  const isWiki = (n: NavNode) => n.sources.some((s) => s.origin === "wiki");
  const pick = (cands: NavNode[]) => cands.sort((a, b) => Number(isWiki(b)) - Number(isWiki(a)) || a.name!.length - b.name!.length)[0];

  const exact = named.filter((n) => base(n.name!) === nq);
  if (exact.length) return pick(exact);
  const qTok = roomTokens(q);
  if (!qTok.length) return null;
  const tok = named.filter((n) => {
    const rt = roomTokens(n.name!);
    return qTok.every((qt) => rt.some((x) => x === qt || x.includes(qt)));
  });
  return tok.length ? pick(tok) : null;
}

/**
 * Edge cost. Wiki (authoritative) is cheaper than marcopolo; a map transition
 * costs a little extra. A command-unknown move gets a SMALL surcharge so that,
 * all else equal, a move with a known command wins — but it stays a perfectly
 * usable path. A horizontal `'`/`..` run in a wiki map is NOT an error: it just
 * says "a path exists here, command unknown", and a marcopolo legend hint often
 * supplies what the command should be (the merge surfaces that as a hinted/known
 * edge for the same move). So a hinted unknown (marcopolo climb, wiki `˄/˅`) is
 * cheaper than a bare one, but neither is penalized enough to force a long detour.
 * See [[marcopolo-secondary-maps]].
 */
const cost = (e: NavEdge): number => {
  const base = (e.transition ? 3 : 0) + (e.origin === "marcopolo" ? 2 : 1);
  if (e.command !== null || e.transition) return base; // concrete move, or a transition (priced above)
  return base + (e.hint ? 1 : 2); // command unknown: mild nudge toward known/hinted moves
};

/** Dijkstra over the unified graph. Emits `RouteStep`s carrying the edge command
 *  (or its hint when the command is unknown) plus the source origin. */
export function routeUnified(g: UnifiedGraph, fromQ: string, toQ: string): RouteResult {
  const s = resolveNode(g, fromQ), t = resolveNode(g, toQ);
  if (!s || !t) return { ok: false, error: `Raum nicht im Regionsgraph gefunden: ${!s ? fromQ : toQ}` };
  if (s.id === t.id) return { ok: false, error: "Start und Ziel sind derselbe Raum" };

  const adj = new Map<string, NavEdge[]>();
  for (const e of g.edges) (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e);
  const name = new Map(g.nodes.map((n) => [n.id, n.name]));

  const dist = new Map<string, number>([[s.id, 0]]);
  const prev = new Map<string, { from: string; e: NavEdge }>();
  const done = new Set<string>();
  const pq = [s.id];
  while (pq.length) {
    let bi = 0; for (let k = 1; k < pq.length; k++) if ((dist.get(pq[k]) ?? Infinity) < (dist.get(pq[bi]) ?? Infinity)) bi = k;
    const cur = pq.splice(bi, 1)[0];
    if (done.has(cur)) continue; done.add(cur);
    if (cur === t.id) break;
    for (const e of adj.get(cur) ?? []) {
      const nd = (dist.get(cur) ?? Infinity) + cost(e);
      if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, { from: cur, e }); pq.push(e.to); }
    }
  }
  if (!prev.has(t.id)) return { ok: false, error: "kein Weg im Regionsgraph" };

  const steps: RouteStep[] = [];
  let cur = t.id;
  while (prev.has(cur)) {
    const { from, e } = prev.get(cur)!;
    steps.unshift({
      dir: e.command,
      hidden: e.command === null,
      transition: e.transition ? "Kartenübergang" : null,
      toName: name.get(e.to) ?? null,
      hint: e.hint ?? null,
      source: e.origin,
    });
    cur = from;
  }
  const clear = steps.every((x) => x.dir && !x.hidden && !x.transition && x.source === "wiki");
  return { ok: true, from: s.name ?? fromQ, to: t.name ?? toQ, steps, clear };
}
