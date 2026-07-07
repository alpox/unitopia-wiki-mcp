import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pageGraphIR } from "../mapGraph.js";
import { extractMcMap } from "../marcopolo/extract.js";
import { buildMcGraph } from "../marcopolo/graph.js";
import { mergeGraphs } from "./merge.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const fixture = (name: string) => readFileSync(join(here, "..", "marcopolo", "__fixtures__", name), "latin1");

test("merge: marcopolo fills wiki gaps, reconciled structurally + by name", () => {
  const wiki = pageGraphIR(readFileSync(join(repo, "knowledgebase/unitopia/handelsweg-borsippa.md"), "utf8"), "handelsweg-borsippa", "Vaniorh");
  const mcW = buildMcGraph(extractMcMap(fixture("wasserfall.html"), "Vaniorh", "Wasserfall", "u")!);
  const mcO = buildMcGraph(extractMcMap(fixture("orkberge.html"), "Vaniorh", "Orkberge", "u")!);
  const g = mergeGraphs("Vaniorh", [wiki], [mcW, mcO]);

  const byName = (s: string) => g.nodes.find((n) => n.name?.startsWith(s) && n.sources.some((x) => x.origin === "wiki"));

  // STRUCTURAL: the wiki room leading to #Drachenkopf binds to marcopolo's D
  // (which links to Drachenkopf.html) — reconciled by shared gateway, not name.
  const drk = byName("Am Drachenkopf");
  assert.ok(drk?.sources.some((s) => s.origin === "marcopolo"), "Drachenkopf bound structurally");

  // NAME: wiki "Bach (Strömung!)" binds to marcopolo "Bach" and gains a fallback
  // edge onward to Wasserfall — the gap the wiki map leaves as '/-> unknowns.
  const bach = byName("Bach");
  const toWasserfall = g.edges.find((e) => e.from === bach!.id && e.origin === "marcopolo");
  assert.ok(toWasserfall, "Bach gained a marcopolo fallback edge");

  // Wiki authority preserved: every wiki edge survives verbatim at priority 1.
  for (const e of wiki.edges) assert.ok(g.edges.some((x) => x.from === e.from && x.to === e.to && x.origin === "wiki"), "wiki edge kept");
  // A marcopolo edge never duplicates a wiki edge that already names a command —
  // it only appears for a NEW pair or to CLARIFY a hidden (command null) wiki move.
  const wikiKnown = new Set(wiki.edges.filter((e) => e.command !== null).map((e) => `${e.from}>${e.to}`));
  for (const e of g.edges) if (e.origin === "marcopolo") assert.ok(!wikiKnown.has(`${e.from}>${e.to}`), "marcopolo never overrides a known wiki command");
  assert.ok(g.edges.some((e) => e.origin === "marcopolo"), "marcopolo fallback edges present");
});
