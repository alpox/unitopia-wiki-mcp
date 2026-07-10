/**
 * Synthesize CROSS-PAGE transition edges between marcopolo maps. A marcopolo tile
 * that continues onto another map (`nodeCross`: e.g. Orkberge's `W` "runter zum
 * Wasserfall klettern" → Wasserfall.html) carries no walkable edge on its own —
 * the raw link only says *which* page continues, not *which room* on it. This
 * step turns those links into real transition edges so the router can actually
 * climb from one map to the next. See [[marcopolo-secondary-maps]] and
 * [[nav-router-crossmap-work]].
 *
 * Pairing is the hard part and is INTERPRETATIONAL (the user's word): two maps
 * often link to each other through several boundary rooms (Orkberge `W`,`L` both
 * → Wasserfall; Wasserfall `t`,`P` both → Orkberge) and only the legend WORDING
 * says which lines up with which (`W` "…Wasserfall" ↔ `P` "Plateau neben einem
 * Wasserfall"; `L` "…zum Bach & Wasserfall … Felshang" ↔ `t` "Felsterasse …
 * runter in den Bach"). We therefore restrict to RECIPROCAL pairs (A links to B's
 * page AND B links back to A's) and disambiguate by shared landmark nouns in the
 * two legend texts (greedy max-weight matching). Non-reciprocal links are left
 * unstitched — better a missing edge than a wrong one in a fallback layer.
 */
import type { McMap } from "./extract.js";
import type { NavEdge, NavNode } from "../graph/types.js";
import { edge } from "../graph/types.js";

export interface BuiltMcMap {
  slug: string;
  m: McMap;
  nodes: NavNode[];
  /** node id → target page basename (from `buildMcGraph`). */
  nodeCross: Map<string, string>;
}

const pnorm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

// Legend words that carry no landmark meaning for pairing (directions, verbs,
// filler). Everything else capitalized is a potential shared landmark.
const STOP = new Set([
  "hier", "kann", "klettern", "klettert", "runter", "hoch", "hochklettern", "runterklettern",
  "einem", "einer", "einen", "durch", "wenn", "dann", "noch", "weiter", "wird", "über", "feld",
  "osten", "westen", "norden", "sueden", "sünden", "kommt", "gehts", "gehen", "steht", "diesem",
]);

/** Landmark tokens of a legend description: capitalized German nouns (≥4 letters),
 *  lowercased, minus direction/filler words. */
function landmarks(desc: string): Set<string> {
  const words = desc.match(/[A-ZÄÖÜ][a-zäöüß]{3,}/g) ?? [];
  return new Set(words.map((w) => w.toLowerCase()).filter((w) => !STOP.has(w)));
}

/** Pairing affinity of two boundary legends: exact landmark hits weigh double,
 *  4-letter stem hits (Felshang↔Felsterasse) weigh one. */
function affinity(da: string, db: string): number {
  const a = landmarks(da), b = landmarks(db);
  let exact = 0; for (const t of a) if (b.has(t)) exact++;
  const sa = new Set([...a].map((w) => w.slice(0, 4))), sb = new Set([...b].map((w) => w.slice(0, 4)));
  let stem = 0; for (const t of sa) if (sb.has(t)) stem++;
  return exact * 2 + stem;
}

/** A per-direction climb hint drawn from the departing room's own legend, since a
 *  transition is usually a climb whose exact verb marcopolo doesn't pin down. */
function transitionHint(desc: string): string {
  const up = /\bhoch|hinauf|aufsteig/i.test(desc), down = /\brunter|hinab|hinunter/i.test(desc);
  const verb = up && !down ? "hochklettern" : down && !up ? "runterklettern" : "klettern";
  return `Kartenwechsel – ${verb} (genauer Befehl unklar)`;
}

export function crossPageEdges(maps: BuiltMcMap[]): NavEdge[] {
  const bySlug = new Map(maps.map((x) => [pnorm(x.slug), x]));
  const descOf = (mp: BuiltMcMap, id: string) => {
    const label = mp.nodes.find((n) => n.id === id)?.sources[0]?.label?.[0] ?? "";
    const entries = mp.m.legend.filter((e) => e.label === label);
    if (entries.length <= 1) return entries[0]?.desc ?? "";
    const at = /@(\d+),(\d+)$/.exec(id); // colour-disambiguate by the node's cell
    const col = at ? mp.m.cellColors.find((cc) => cc.row === +at[1] && cc.col === +at[2])?.color : undefined;
    return (entries.find((e) => e.color === col) ?? entries[0]).desc;
  };
  // Directed boundary rooms per map: node id → target page (normalized).
  const exits = (mp: BuiltMcMap) => [...mp.nodeCross].map(([id, page]) => ({ id, page: pnorm(page) }));

  const out: NavEdge[] = [];
  const seenPair = new Set<string>(); // unordered page pair, processed once
  for (const A of maps) {
    for (const { page: bPage } of exits(A)) {
      const B = bySlug.get(bPage);
      if (!B) continue;
      const pairKey = [pnorm(A.slug), B.slug === A.slug ? "" : pnorm(B.slug)].sort().join("|");
      if (A.slug === B.slug || seenPair.has(pairKey)) continue;
      seenPair.add(pairKey);

      const aExits = exits(A).filter((e) => e.page === pnorm(B.slug));
      const bExits = exits(B).filter((e) => e.page === pnorm(A.slug)); // reciprocal only
      if (!aExits.length || !bExits.length) continue;

      // Greedy max-weight matching over the reciprocal candidates.
      const cand = aExits.flatMap((a) => bExits.map((b) => ({ a: a.id, b: b.id, w: affinity(descOf(A, a.id), descOf(B, b.id)) })));
      cand.sort((x, y) => y.w - x.w);
      const usedA = new Set<string>(), usedB = new Set<string>();
      for (const c of cand) {
        if (usedA.has(c.a) || usedB.has(c.b)) continue;
        usedA.add(c.a); usedB.add(c.b);
        const da = descOf(A, c.a), db = descOf(B, c.b);
        out.push(edge(c.a, c.b, null, "marcopolo", A.slug, { hint: transitionHint(da), transition: true }));
        out.push(edge(c.b, c.a, null, "marcopolo", B.slug, { hint: transitionHint(db), transition: true }));
      }
    }
  }
  return out;
}
