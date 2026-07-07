import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractMcMap } from "./extract.js";
import { buildMcGraph } from "./graph.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, "__fixtures__", name), "latin1");

test("marcopolo graph: Bach→Wasserfall→Plateau connectivity fills the wiki gap", () => {
  const m = extractMcMap(fixture("wasserfall.html"), "Vaniorh", "Wasserfall", "u")!;
  const g = buildMcGraph(m);
  const name = new Map(g.nodes.map((n) => [n.id, n.name]));
  const has = (from: string, to: string) =>
    g.edges.find((e) => name.get(e.from)?.startsWith(from) && name.get(e.to)?.startsWith(to));

  // The chain the wiki's `15 Bach` region leaves as `'`/`->` unknowns.
  const bw = has("Bach", "Wasserfall");
  assert.ok(bw, "Bach → Wasserfall edge exists");
  assert.equal(bw!.command, "osten");
  assert.equal(bw!.origin, "marcopolo");
  assert.equal(bw!.priority, 2);
  assert.ok(has("Wasserfall", "Plateau"), "Wasserfall → Plateau edge exists");

  // A vertical move is a stair-like "hoch"/"runter" by default — NOT asserted as
  // a climb — but carries a soft uncertainty hint when the legend hints at one.
  const vert = g.edges.find((e) => (e.command === "hoch" || e.command === "runter") && /klettern|Sonderbefehl/.test(e.hint ?? ""));
  assert.ok(vert, "a hoch/runter edge with an uncertainty hint exists");
  assert.ok(!g.edges.some((e) => e.command === "hochklettern" || e.command === "runterklettern"), "never asserts a specific climb command");

  // Cross-page portals are captured for the merge step.
  const portals = new Set(g.nodeCross.values());
  for (const p of ["Orkberge", "Drachenkopf", "Orkhoehlen"]) assert.ok(portals.has(p), `portal to ${p}`);
});

test("marcopolo graph: a custom-command connects two label instances (Nebelgebirge v↔v)", () => {
  const m = extractMcMap(fixture("nebelgebirge.html"), "Midgard", "Nebelgebirge", "u")!;
  const g = buildMcGraph(m);
  const name = new Map(g.nodes.map((n) => [n.id, n.name]));
  // The two "Vor einer Schneewehe" (`v`) cells are joined with NO wire, via the
  // legend's custom crawl instruction — command unknown, instruction as hint.
  const crawl = g.edges.find(
    (e) => /Schneewehe/.test(name.get(e.from) ?? "") && /Schneewehe/.test(name.get(e.to) ?? "") &&
      e.from !== e.to && e.command === null && /Spalt/i.test(e.hint ?? ""),
  );
  assert.ok(crawl, "custom crawl edge between the two Schneewehe cells exists");
});
