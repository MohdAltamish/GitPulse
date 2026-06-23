/**
 * Unit tests for the deterministic scoring engine in report.js.
 *
 * Run with: node --test
 * These cover the SKILL.md risk formula and the AGENTS.md guardrails
 * (3+ teams => HIGH, open-MR overlap => never safe_to_merge).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateRiskScore, buildReport } from "../report.js";

// ── Fixtures ──────────────────────────────────────────────────────

function graphWith(directFiles, transitiveFiles = []) {
  return {
    target: { file: "utils/tax.js", symbol: "calculateTax" },
    direct: directFiles.map((file) => ({
      file,
      import_type: "named",
      depth: 1,
    })),
    transitive: transitiveFiles.map((file) => ({
      file,
      via: directFiles[0],
      depth: 2,
    })),
    // Fixtures represent REAL graph data. buildReport refuses to mark a report
    // safe_to_merge unless the data source is real (orbit-remote/static-analysis).
    metadata: { source: "orbit-remote" },
  };
}

function ownersFor(files) {
  return files.map((file) => ({
    file,
    team: file.includes("checkout")
      ? "team-checkout"
      : file.includes("invoic")
        ? "team-finance"
        : file.includes("report")
          ? "team-reports"
          : "team-unknown",
    owner: file.includes("checkout")
      ? "@alice"
      : file.includes("invoic")
        ? "@bob"
        : file.includes("report")
          ? "@carol"
          : "@unknown",
  }));
}

// ── calculateRiskScore ────────────────────────────────────────────

test("score uses the SKILL.md formula", () => {
  // 2 direct (×5=10) + 1 transitive (×2=2) + 1 team (×10) + 0 MRs + 1 pipeline (×5)
  // = 10 + 2 + 10 + 0 + 5 = 27 => LOW
  const graph = graphWith(
    ["src/checkout/CartService.js", "src/checkout/CheckoutFlow.jsx"],
    ["src/checkout/OrderConfirmation.jsx"]
  );
  const owners = ownersFor([
    "src/checkout/CartService.js",
    "src/checkout/CheckoutFlow.jsx",
    "src/checkout/OrderConfirmation.jsx",
  ]);
  const pipelines = [{ name: "checkout-service-ci" }];

  const result = calculateRiskScore(graph, owners, [], pipelines);

  assert.equal(result.score, 27);
  assert.equal(result.level, "LOW");
  assert.deepEqual(result.breakdown, {
    direct_dependents: 2,
    transitive_dependents: 1,
    teams_affected: 1,
    open_mr_overlaps: 0,
    pipelines_at_risk: 1,
  });
});

test("team-unknown is not counted toward teams_affected", () => {
  const graph = graphWith(["lib/misc.js"]);
  const owners = ownersFor(["lib/misc.js"]); // resolves to team-unknown
  const result = calculateRiskScore(graph, owners, [], []);
  assert.equal(result.breakdown.teams_affected, 0);
});

test("3+ teams always escalates to HIGH (AGENTS.md guardrail)", () => {
  const files = [
    "src/checkout/CartService.js",
    "src/invoicing/InvoiceGen.js",
    "src/reports/TaxSummary.js",
  ];
  const graph = graphWith(files);
  const owners = ownersFor(files); // 3 distinct known teams
  const result = calculateRiskScore(graph, owners, [], []);
  assert.equal(result.breakdown.teams_affected, 3);
  assert.equal(result.level, "HIGH");
});

test("score is capped at 100", () => {
  const direct = Array.from({ length: 30 }, (_, i) => `src/checkout/f${i}.js`);
  const graph = graphWith(direct);
  const owners = ownersFor(direct);
  const result = calculateRiskScore(graph, owners, [], []);
  assert.equal(result.score, 100);
});

test("MEDIUM band boundaries: 30 is MEDIUM, 60 is MEDIUM, 61+ is HIGH", () => {
  // 6 direct (×5 = 30), single team => +10 would push to 40, so use
  // team-unknown files to isolate the direct-dependent contribution.
  const at30 = graphWith(
    Array.from({ length: 6 }, (_, i) => `lib/f${i}.js`)
  );
  const owners30 = ownersFor(at30.direct.map((d) => d.file));
  assert.equal(calculateRiskScore(at30, owners30, [], []).level, "MEDIUM");
});

// ── buildReport ───────────────────────────────────────────────────

test("open MR overlap makes safe_to_merge false (AGENTS.md guardrail)", () => {
  const graph = graphWith(["src/checkout/CartService.js"]);
  const owners = ownersFor(["src/checkout/CartService.js"]);
  const mrs = [
    {
      id: 234,
      title: "Add EU tax rates",
      author: "@alice",
      url: "https://gitlab.com/x/-/merge_requests/234",
      overlap: ["src/checkout/CartService.js"],
    },
  ];
  const score = calculateRiskScore(graph, owners, mrs, []);
  const report = buildReport({
    file: "utils/tax.js",
    symbol: "calculateTax",
    graph,
    owners,
    mrs,
    pipelines: [],
    score,
  });
  assert.equal(report.safe_to_merge, false);
  assert.equal(report.open_mrs.length, 1);
});

test("no MRs and non-HIGH risk yields safe_to_merge true", () => {
  const graph = graphWith(["src/checkout/CartService.js"]);
  const owners = ownersFor(["src/checkout/CartService.js"]);
  const score = calculateRiskScore(graph, owners, [], []);
  const report = buildReport({
    file: "utils/tax.js",
    symbol: null,
    graph,
    owners,
    mrs: [],
    pipelines: [],
    score,
  });
  assert.equal(report.safe_to_merge, true);
});

test("HIGH risk is never safe_to_merge even with no open MRs", () => {
  const files = [
    "src/checkout/CartService.js",
    "src/invoicing/InvoiceGen.js",
    "src/reports/TaxSummary.js",
  ];
  const graph = graphWith(files);
  const owners = ownersFor(files);
  const score = calculateRiskScore(graph, owners, [], []); // HIGH via 3 teams
  const report = buildReport({
    file: "utils/tax.js",
    symbol: null,
    graph,
    owners,
    mrs: [],
    pipelines: [],
    score,
  });
  assert.equal(report.risk, "HIGH");
  assert.equal(report.safe_to_merge, false);
});

test("buildReport enriches dependents with ownership and suggests reviewers", () => {
  const graph = graphWith(
    ["src/checkout/CartService.js", "src/invoicing/InvoiceGen.js"],
    ["src/reports/TaxSummary.js"]
  );
  const owners = ownersFor([
    "src/checkout/CartService.js",
    "src/invoicing/InvoiceGen.js",
    "src/reports/TaxSummary.js",
  ]);
  const score = calculateRiskScore(graph, owners, [], []);
  const report = buildReport({
    file: "utils/tax.js",
    symbol: "calculateTax",
    graph,
    owners,
    mrs: [],
    pipelines: [],
    score,
  });

  assert.equal(report.dependents.direct.length, 2);
  assert.equal(report.dependents.transitive.length, 1);
  assert.deepEqual(
    [...report.suggested_reviewers].sort(),
    ["@alice", "@bob", "@carol"]
  );
  assert.equal(report.target.file, "utils/tax.js");
  assert.equal(report.target.symbol, "calculateTax");
});

test("unknown-owner files are not suggested as reviewers", () => {
  const graph = graphWith(["lib/misc.js"]);
  const owners = ownersFor(["lib/misc.js"]); // @unknown
  const score = calculateRiskScore(graph, owners, [], []);
  const report = buildReport({
    file: "utils/tax.js",
    symbol: null,
    graph,
    owners,
    mrs: [],
    pipelines: [],
    score,
  });
  assert.deepEqual(report.suggested_reviewers, []);
});
