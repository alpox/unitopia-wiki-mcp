import { test } from "node:test";
import assert from "node:assert/strict";
import type { McMap } from "./extract.js";
import { penetrableEntrances, bySide } from "./entrances.js";

/** Minimal McMap carrying only what penetrableEntrances reads (cellLinks). */
const mk = (cellLinks: McMap["cellLinks"]): McMap => ({
  slug: "g-wald", region: "Gallien", title: "", ascii: "",
  legend: [], cellColors: [], cellLinks, crossPages: [], sourceUrl: "",
});

test("penetrableEntrances: classifies crossings onto sides + ordinals", () => {
  // Mirrors the real gallien G_Wald crossings: N 2×W +1 river h, E 3, S 2, W 5.
  const g = "/_marcopolo/gallien/gallien.md";
  const m = mk([
    { row: 1, col: 14, label: "W", page: g },
    { row: 1, col: 28, label: "W", page: g },
    { row: 1, col: 38, label: "h", page: g },
    { row: 15, col: 48, label: "W", page: g },
    { row: 35, col: 48, label: "W", page: g },
    { row: 49, col: 48, label: "W", page: g },
    { row: 57, col: 14, label: "W", page: g },
    { row: 57, col: 38, label: "W", page: g },
    { row: 23, col: 2, label: "W", page: g },
    { row: 35, col: 2, label: "W", page: g },
    { row: 43, col: 2, label: "W", page: g },
    { row: 45, col: 2, label: "W", page: g },
    { row: 47, col: 2, label: "W", page: g },
  ]);
  const s = bySide(penetrableEntrances(m, "gallien"));
  assert.deepEqual([s.N.length, s.E.length, s.S.length, s.W.length], [3, 3, 2, 5]);
  // N ordered by column: 14, 28, 38 (river last)
  assert.deepEqual(s.N.map((e) => e.col), [14, 28, 38]);
  // W ordered by row (top→bottom)
  assert.deepEqual(s.W.map((e) => e.row), [23, 35, 43, 45, 47]);
});

test("penetrableEntrances: drops multi-glyph annotation labels + resolves corners", () => {
  const g = "/_marcopolo/gallien/g-wald.md";
  const m = mk([
    { row: 62, col: 36, label: "W", page: g },
    { row: 70, col: 34, label: "gall.Wald", page: g }, // NAME cell, not a crossing
    { row: 78, col: 42, label: "W", page: g },          // SE corner → resolves to S
  ]);
  const ent = penetrableEntrances(m, "g-wald");
  assert.equal(ent.length, 2, "multi-glyph annotation label dropped");
  const corner = ent.find((e) => e.row === 78 && e.col === 42)!;
  assert.equal(corner.side, "S", "corner resolves to its row-extreme side");
});

test("penetrableEntrances: filters by target page", () => {
  const m = mk([
    { row: 43, col: 20, label: "t", page: "/_marcopolo/gallien/trabantenstadt.md" },
    { row: 1, col: 14, label: "W", page: "/_marcopolo/gallien/gallien.md" },
  ]);
  assert.equal(penetrableEntrances(m, "trabantenstadt").length, 1);
  assert.equal(penetrableEntrances(m, "gallien").length, 1);
});
