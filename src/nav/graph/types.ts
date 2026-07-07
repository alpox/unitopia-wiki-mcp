/**
 * The unified navigation graph IR — the single serialized artifact that both the
 * router (fallback edges) and a future custom map renderer consume. See
 * [[marcopolo-secondary-maps]] and [[nav-router-crossmap-work]].
 *
 * Hard design constraints (from the user):
 *  - EVERYTHING is nodes and edges. A transfer whose command is unknown is still
 *    an edge — just one with `command: null` (optionally carrying a `hint`).
 *  - An EDGE IS THE COMMAND needed to go from `from` to `to` (directed). The
 *    reverse move is a separate edge with its own command.
 *  - The IR does NOT retain the source ASCII. Reproducing the original map is a
 *    non-goal; only *custom* rendering from this topology must be possible. No
 *    field here may contain raw map art.
 */

/** Which source asserted a node/edge. Wiki is authoritative; marcopolo is the
 *  older fan-site fallback used only to fill gaps the wiki leaves. */
export type Origin = "wiki" | "marcopolo";
/** Trust rank derived from origin: lower wins. Wiki = 1, marcopolo = 2. */
export const PRIORITY: Record<Origin, number> = { wiki: 1, marcopolo: 2 };

export interface NavEdge {
  /** Source node id. */
  from: string;
  /** Target node id. */
  to: string;
  /**
   * The concrete in-game command to make this move if it is known — a compass
   * word ("osten", "suedwesten"), a z-move ("hoch"/"runter"), or null when the
   * command is genuinely unknown (the old "tüfteln" transfer). Never map ASCII.
   */
  command: string | null;
  /**
   * A human traversal hint when `command` is null or imprecise — e.g.
   * "hochklettern", "runterklettern", "Strömung treibt nach Osten". Derived from
   * legends/prose, NOT from grid characters. null when there is nothing to add.
   */
  hint: string | null;
  /** True if this edge crosses between two source maps (a "Karte wechselt" hop).
   *  Rendering can draw these differently; routing treats them as ~1 move. */
  transition?: boolean;
  origin: Origin;
  /** = PRIORITY[origin]; denormalized so consumers need not import the map. */
  priority: number;
  /** Source page slug this edge was derived from (provenance/debugging). */
  sourcePage: string;
}

export interface NodeSource {
  origin: Origin;
  /** Page slug the node appears on (wiki page id or marcopolo basename). */
  page: string;
  /** The label the node carried on that source map (e.g. "15" or "b"). */
  label: string;
}

export interface NavNode {
  /** Stable unified id (post-merge canonical, or source-local pre-merge). */
  id: string;
  /** Canonical room name, or null if the source gave only a bare label. */
  name: string | null;
  /** Other names/spellings seen for this node across sources. */
  aliases: string[];
  region: string;
  /** Every source map (and label) this unified node was seen on. */
  sources: NodeSource[];
  /**
   * Normalized names of OTHER maps/areas this node is a gateway to (e.g.
   * "drachenkopf", "tadmor", "orkhoehlen"). Both sources share this canonical
   * page vocabulary, so it is the primary STRUCTURAL key for reconciling a
   * marcopolo boundary room with its wiki counterpart — more reliable than the
   * differing room NAMES. Empty for interior rooms.
   */
  portals?: string[];
}

export interface UnifiedGraph {
  region: string;
  nodes: NavNode[];
  edges: NavEdge[];
  /** Build provenance: which source pages fed this graph. */
  builtFrom: { origin: Origin; pages: string[] }[];
}

/** Convenience: a directed edge helper that fills priority from origin. */
export function edge(
  from: string,
  to: string,
  command: string | null,
  origin: Origin,
  sourcePage: string,
  extra: { hint?: string | null; transition?: boolean } = {},
): NavEdge {
  return {
    from,
    to,
    command,
    hint: extra.hint ?? null,
    ...(extra.transition ? { transition: true } : {}),
    origin,
    priority: PRIORITY[origin],
    sourcePage,
  };
}
