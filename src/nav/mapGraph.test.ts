/**
 * Golden regression tests for the ASCII map parser/router.
 *
 *   npm test            (node --test via tsx)
 *
 * Assertions run against REAL KB map pages (ground-truth art), so they double as
 * a safety net for any future rewrite of the crossing/segmentation logic. Expected
 * routes were hand-verified from each map's legend.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { routeOnPage, pageMaps, listRooms, diagnosePage, subMapEntrances } from "./mapGraph.js";
import { config } from "../config.js";

const read = (slug: string) => readFileSync(join(config.kbDir, `${slug}.md`), "utf8");
const dirs = (r: ReturnType<typeof routeOnPage>) =>
  r.steps!.map((s) => (s.transition ? "T" : `${s.dir}${s.hidden ? "*" : ""}`)).join(" ");

// ---------------------------------------------------------------------------
// Regression: sub-map entrance classification (overworld→ASCII seam). The
// gallierwald "1 Rand" edge rooms (linking back to the gallien overworld) must be
// classified per side/ordinal — and must NOT catch a same-labelled interior room
// on another sub-map ("1 Kellergeschoss" in the Trabantenstadt sub-map). Matches
// the marcopolo g-wald entrance counts (N2 E3 S2 W5) by side.
// ---------------------------------------------------------------------------
test("gallierwald: subMapEntrances classifies the '1 Rand' edges by side", () => {
  const ent = subMapEntrances(read("gallierwald"), "gallien");
  assert.ok(ent.every((e) => e.name === "Rand"), "only region-linked 'Rand' rooms, no interior sub-map rooms");
  assert.ok(ent.every((e) => e.group === 0), "all on the main map group, not the Trabantenstadt/Waldhaus sub-maps");
  const bySide = (s: string) => ent.filter((e) => e.side === s).length;
  assert.deepEqual([bySide("N"), bySide("E"), bySide("S"), bySide("W")], [2, 3, 2, 5]);
  // ordinals are contiguous 0..n-1 per side
  for (const s of ["N", "E", "S", "W"]) {
    const ords = ent.filter((e) => e.side === s).map((e) => e.ordinal).sort((a, b) => a - b);
    assert.deepEqual(ords, ords.map((_, i) => i));
  }
});

// Regression: the Burg Tregyln map (drachenland.md) is drawn with box-drawing
// glyphs incl. a "┌┼┐ / ┘o└" bridge crossing and "\_'\_" diagonals. Before the
// isMapLine/CLS segmentation fix, these corner/underscore rows failed the map-
// line test and shattered the map into 4 fragments, so its room labels attached
// to the wrong fragment and none of its rooms could be routed. Guard that it
// stays a single, fully-routable map.
// ---------------------------------------------------------------------------
test("drachenland: Burg Tregyln parses as one whole map with all rooms", () => {
  const md = read("drachenland");
  const burg = pageMaps(md).filter((m) => m.anchor === "Burg_Tregyln");
  assert.equal(burg.length, 1, "Burg Tregyln must be a single un-fragmented map group");
  assert.equal(burg[0].rooms.length, 16, "all 16 legend rooms attach to the one map");
  const names = listRooms(md).map((r) => r.name);
  for (const room of ["Schmiede", "Arsenal", "Thronsaal", "Küche", "Verlies"])
    assert.ok(names.some((n) => n?.startsWith(room)), `room "${room}" is resolvable`);
});

test("drachenland: Burg Tregyln routes are correct", () => {
  const md = read("drachenland");
  // 6 Thronsaal -> 8 Sabines Schlafgemach: north to the Gang (7), then east.
  const r1 = routeOnPage(md, "Thronsaal", "Sabines Schlafgemach");
  assert.ok(r1.ok, r1.error);
  assert.equal(dirs(r1), "norden osten");
  // 4 Schmiede -> 11 Küche: a connected path exists (FAILED pre-fix).
  const r2 = routeOnPage(md, "Schmiede", "Küche");
  assert.ok(r2.ok, r2.error);
  assert.ok(r2.clear, "Schmiede->Küche is a clean compass route");
});

// ---------------------------------------------------------------------------
// Tadmor: verified simple cases across the city stadtplan.
// ---------------------------------------------------------------------------
test("tadmor: Nordtor -> Stadttor Nord is a single step south", () => {
  const r = routeOnPage(read("tadmor"), "Nordtor", "Stadttor Nord");
  assert.ok(r.ok, r.error);
  assert.equal(dirs(r), "sueden");
  assert.ok(r.clear);
});

test("tadmor: the river bridges (Holzsteg/Neue Brücke) are dot-crossed, not fused", () => {
  // "F-.6..7.-F": the Dijala flows under 6 and 7 via dot-flanking, so 6 and 7
  // are NOT directly wired east-west through the river. A route still exists,
  // but must not be the single spurious "osten" step across the water.
  const r = routeOnPage(read("tadmor"), "Holzsteg", "Neue Brücke");
  assert.ok(r.ok, r.error);
  assert.notEqual(dirs(r), "osten", "must not fuse 6-7 straight through the river");
});

// ---------------------------------------------------------------------------
// Drachenberge Klosterberg (the corpus' hardest map): diagonal + spaced-out ˄/˅
// climb ladders, ' quote-lines, a "˅--+---" crossover and |\/| weave textures.
// The S→T route must be a single CLEAN climb corridor with no hidden ("hickup")
// steps. Every step is verified against the map legend. Note pos.13 is
// "suedwesten": node 5 (Drachentreppe) → T runs down the "/" diagonal (down AND
// left); T connects to nothing else, so the final approach is geometrically SW.
// ---------------------------------------------------------------------------
test("drachenberge: Steg der Moaki-Bucht -> Tempel der 'BlueOrb' is a clean climb", () => {
  const r = routeOnPage(read("drachenberge"), "Steg der Moaki-Bucht", "Tempel der 'BlueOrb'");
  assert.ok(r.ok, r.error);
  assert.equal(
    r.steps!.map((s) => s.dir).join(", "),
    "osten, suedosten, suedwesten, hoch, hoch, hoch, hoch, hoch, osten, hoch, hoch, hoch, suedwesten",
  );
  assert.ok(r.steps!.every((s) => !s.hidden), "no hidden/unreadable steps — a clean corridor");
});

// ---------------------------------------------------------------------------
// Corpus invariants: nothing the parser accepts should throw, and the known
// map pages must keep producing graphs (guards against a fix that regresses
// segmentation and drops maps).
// ---------------------------------------------------------------------------
test("every map-hint page parses without throwing", () => {
  const MAP_HINT = /[┌┐└┘┼]|o--|--o/;
  let graphs = 0, scanned = 0;
  for (const f of readdirSync(config.kbDir)) {
    if (!f.endsWith(".md")) continue;
    const md = readFileSync(join(config.kbDir, f), "utf8");
    if (!MAP_HINT.test(md)) continue;
    scanned++;
    let d: ReturnType<typeof diagnosePage> = null;
    assert.doesNotThrow(() => { d = diagnosePage(md); }, `parsing ${f} threw`);
    if (d) graphs++;
  }
  // Baseline captured during the measure-first audit: 122 candidate pages,
  // 117 yielding graphs (the 5 misses use an unsupported inline-label style).
  assert.ok(scanned >= 120, `expected >=120 map-hint pages, got ${scanned}`);
  assert.ok(graphs >= 117, `expected >=117 parseable maps, got ${graphs}`);
});
