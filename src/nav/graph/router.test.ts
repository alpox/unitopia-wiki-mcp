/**
 * Fallback region-graph router tests. This router runs ONLY as a last resort,
 * autonomously (no LLM in the loop), across every region graph — so its node
 * resolution must never trade a specific proper noun for a generic substring
 * collision, which used to fabricate confident routes between unrelated places
 * ("Moaki-Bucht" → "Bucht (Kurstafel)", "Tempel der BlueOrb" → "Tempel").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeUnified } from "./router.js";
import { edge, type NavNode, type UnifiedGraph } from "./types.js";

const node = (id: string, name: string | null): NavNode => ({
  id, name, aliases: [], region: "Test", sources: [{ origin: "marcopolo", page: "t", label: "" }],
});
const graph = (nodes: NavNode[], edges: UnifiedGraph["edges"]): UnifiedGraph => ({
  region: "Test", nodes, edges, builtFrom: [],
});

test("fallback router: a generic room does not stand in for a multi-word proper noun", () => {
  // Only generic "Bucht"/"Tempel" rooms exist here, wired together. The specific
  // query must NOT collapse onto them and manufacture a route.
  const g = graph(
    [node("a", "Bucht (Kurstafel)"), node("b", "Tempel")],
    [edge("a", "b", "osten", "marcopolo", "t")],
  );
  const r = routeUnified(g, "Moaki-Bucht", "Tempel der BlueOrb");
  assert.equal(r.ok, false, "must decline rather than route between coincidental generics");
});

test("fallback router: exact-token proper nouns still resolve and route", () => {
  const g = graph(
    [node("a", "Steg der Moaki-Bucht"), node("b", "Tempel der 'BlueOrb'")],
    [edge("a", "b", "osten", "marcopolo", "t")],
  );
  const r = routeUnified(g, "Moaki-Bucht", "Tempel der BlueOrb");
  assert.equal(r.ok, true, "every query token is present in the target room name");
  assert.equal(r.from, "Steg der Moaki-Bucht");
  assert.equal(r.to, "Tempel der 'BlueOrb'");
});

test("fallback router: a nonsense query resolves to nothing", () => {
  const g = graph(
    [node("a", "Steg der Moaki-Bucht"), node("b", "Tempel der 'BlueOrb'")],
    [edge("a", "b", "osten", "marcopolo", "t")],
  );
  // A garbage token must not swallow a short real token ("...room" ⊃ nothing here).
  const r = routeUnified(g, "Steg der Moaki-Bucht", "Zzznonexistentroom");
  assert.equal(r.ok, false);
});
