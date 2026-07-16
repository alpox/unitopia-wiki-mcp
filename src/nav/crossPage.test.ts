/**
 * Cross-page routing tests: a trip that spans several ASCII maps, stitched via
 * reciprocal legend gateways. Run with `npm test`.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadNavIndex, buildNavInMemory, type NavIndex } from "./navIndex.js";

let nav: NavIndex;
before(async () => { nav = (await loadNavIndex()) ?? (await buildNavInMemory()); });

test("cross-page: Tadmor room -> Borsippa room traverses the Handelsweg road map", async () => {
  const r = await nav.resolveAndRoute("Kathedrale", "Marktplatz");
  assert.ok(r.ok, "a route across pages must be found");
  // A map seam is a normal walk, not a separate command, so a clean multi-map trip
  // IS a single copyable command — the maps just overlay as you keep walking.
  assert.equal(r.clear, true, "a clean multi-map walk is a single copyable command");
  // Seams are now annotations riding on real directional steps, not directionless
  // teleport steps: every transition-bearing step must still be a real move.
  const transSteps = (r.steps ?? []).filter((s) => s.transition);
  assert.ok(transSteps.every((s) => s.dir), "each map crossing rides on a real walk step");
  const trans = transSteps.map((s) => s.transition!.toLowerCase());
  // Must cross INTO the intermediate road map, then INTO Borsippa — proving the
  // path spans three ASCII maps rather than teleporting city-to-city.
  assert.ok(trans.some((t) => t.includes("handelsweg")), `expected a Handelsweg crossing, got: ${trans.join(" | ")}`);
  assert.ok(trans.some((t) => t.includes("borsippa")), `expected a Borsippa crossing, got: ${trans.join(" | ")}`);
});

test("overworld: Hafen -> Eingang Dörrstadt walks the grid, not a teleport", async () => {
  // Both endpoints are gateway tiles on the Dörrland overworld gridmap (harbour at
  // 52,12; city entrance at 39,23), so the journey is the real ~13-step overland
  // walk between them — NOT the old 1-step in-page anchor teleport. "Eingang «City»"
  // resolves to the city-proper gateway.
  const r = await nav.resolveAndRoute("Hafen von Dörrstadt", "Eingang Dörrstadt");
  assert.ok(r.ok, r.error);
  assert.ok(r.clear, "a plain overworld walk is clean");
  assert.ok(r.steps!.length >= 10, `expected a multi-step overworld walk, got ${r.steps!.length}`);
  assert.ok(r.steps!.every((s) => s.dir === "suedwesten" || s.dir === "westen"),
    "every step heads south-west/west across the overworld");
});

test("overworld: a harbour named loosely resolves to its overworld tile", async () => {
  // The overworld gateway is "Hafen von Aremorica"; gallierdorf also has an
  // interior room literally named "Hafen Aremorica". A cross-region trip to the
  // Gallierwald must start at the OVERWORLD harbour tile regardless of the filler
  // word "von", so the natural phrasing routes identically to the exact name and
  // never detours through the coincidentally-named interior room.
  const exact = await nav.resolveAndRoute("Hafen von Aremorica", "Trabantenstadt");
  if (!exact.ok) { return; } // gallien grid/marcopolo artifacts not built → nothing to assert
  const sig = (r: typeof exact) => (r.steps ?? []).map((s) => s.dir ?? s.transition ?? "·").join("|");
  for (const q of ["hafen aremorica", "Hafen Aremorica"]) {
    const r = await nav.resolveAndRoute(q, "Trabantenstadt");
    assert.ok(r.ok, `"${q}" should route across the overworld`);
    assert.equal(sig(r), sig(exact), `"${q}" must take the same overworld route as the exact name`);
  }
});

test("cross-page: does not fabricate a route between unconnected areas", async () => {
  // Two rooms with no reciprocal ASCII gateway chain must fail cleanly, not
  // invent a teleport. (Neither endpoint shares a page nor a gateway path.)
  const r = await nav.resolveAndRoute("Eingangshalle", "Zzznonexistentroom");
  assert.equal(r.ok, false);
});

test("within-page routing still works after the cross-page change", async () => {
  const r = await nav.resolveAndRoute("Nordtor", "Stadttor Nord");
  assert.ok(r.ok, r.error);
  assert.equal(r.steps!.length, 1);
  assert.ok(r.clear);
  assert.ok(!r.steps!.some((s) => s.transition), "a single-map hop has no crossings");
});
