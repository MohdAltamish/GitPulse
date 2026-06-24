/**
 * Unit tests for the breaking-change heuristics in diff-analyzer.js.
 *
 * Run with: node --test
 * These deliberately include a cosmetic-only diff to guard against false
 * positives, since over-reporting would undermine GitPulse's honesty pitch.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeBreakingChanges } from "../diff-analyzer.js";

test("detects a removed export with high confidence", () => {
  const diff = [
    "--- a/utils/tax.js",
    "+++ b/utils/tax.js",
    "@@ -1,3 +1,2 @@",
    "-export const VAT_RATE = 0.2;",
    " const internal = 1;",
  ].join("\n");
  const result = analyzeBreakingChanges(diff);
  const hit = result.find((r) => r.type === "export_removed");
  assert.ok(hit, "expected an export_removed finding");
  assert.equal(hit.confidence, "high");
  assert.match(hit.detail, /VAT_RATE/);
});

test("flags a likely function rename", () => {
  const diff = [
    "@@ -1,2 +1,2 @@",
    "-function classifyPayload(x) {",
    "+function classify_payload(x) {",
  ].join("\n");
  const result = analyzeBreakingChanges(diff);
  const hit = result.find((r) => r.type === "function_renamed");
  assert.ok(hit, "expected a function_renamed finding");
  assert.equal(hit.confidence, "medium");
});

test("detects removal of an arrow-style export", () => {
  const diff = [
    "@@ -1,4 +1,3 @@",
    "-export const scoreLabel = (n) => n > 60 ? 'HIGH' : 'LOW';",
    " export const keep = 1;",
  ].join("\n");
  const result = analyzeBreakingChanges(diff);
  const hit = result.find((r) => r.type === "export_removed");
  assert.ok(hit, "expected arrow export removal to be detected");
  assert.match(hit.detail, /scoreLabel/);
});

test("cosmetic-only diff yields no breaking changes", () => {
  const diff = [
    "@@ -1,3 +1,3 @@",
    "-  const x = 1;",
    "+    const x = 1;",
    "-// old comment",
    "+// new comment",
  ].join("\n");
  const result = analyzeBreakingChanges(diff);
  assert.deepEqual(result, []);
});

test("empty or missing diff is safe", () => {
  assert.deepEqual(analyzeBreakingChanges(""), []);
  assert.deepEqual(analyzeBreakingChanges(undefined), []);
  assert.deepEqual(analyzeBreakingChanges(null), []);
});

test("re-adding an export under the same name is not breaking", () => {
  const diff = [
    "@@ -1,2 +1,2 @@",
    "-export function calc(a) { return a; }",
    "+export function calc(a, b) { return a + b; }",
  ].join("\n");
  const result = analyzeBreakingChanges(diff);
  assert.equal(
    result.find((r) => r.type === "export_removed"),
    undefined,
    "same-name export should not count as removed"
  );
});
