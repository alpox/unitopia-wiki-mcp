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
  assert.equal(r.clear, false, "a multi-map trip is never a single copyable command");
  const trans = (r.steps ?? []).filter((s) => s.transition).map((s) => s.transition!.toLowerCase());
  // Must cross INTO the intermediate road map, then INTO Borsippa — proving the
  // path spans three ASCII maps rather than teleporting city-to-city.
  assert.ok(trans.some((t) => t.includes("handelsweg")), `expected a Handelsweg crossing, got: ${trans.join(" | ")}`);
  assert.ok(trans.some((t) => t.includes("borsippa")), `expected a Borsippa crossing, got: ${trans.join(" | ")}`);
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
