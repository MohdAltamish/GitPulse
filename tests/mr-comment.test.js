/**
 * Tests for the MR-comment integration (mr-comment.js).
 *
 * Covers markdown rendering from a report object and the
 * update-vs-create decision based on the hidden marker. fetch is stubbed.
 *
 * Run with: node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderReportMarkdown,
  postReportComment,
  REPORT_MARKER,
} from "../mr-comment.js";

function sampleReport(overrides = {}) {
  return {
    target: { file: "utils/tax.js", symbol: "calculateTax" },
    risk: "HIGH",
    risk_score: 75,
    risk_line: "Risk: HIGH (score: 75/100)",
    summary: "5 dependents across 3 teams. 1 open MR touches related code.",
    dependents: { direct: [], transitive: [] },
    teams_affected: [],
    open_mrs: [{ id: 234, title: "Add EU tax rates", author: "@alice" }],
    pipelines_at_risk: [],
    suggested_reviewers: ["@alice", "@bob"],
    safe_to_merge: false,
    score_breakdown: {
      direct_dependents: 2,
      transitive_dependents: 3,
      teams_affected: 3,
      open_mr_overlaps: 1,
      pipelines_at_risk: 0,
    },
    data_source: "orbit-remote",
    is_real_data: true,
    ...overrides,
  };
}

test("markdown includes the hidden marker and the canonical risk line", () => {
  const md = renderReportMarkdown(sampleReport());
  assert.ok(md.startsWith(REPORT_MARKER));
  assert.ok(md.includes("Risk: HIGH (score: 75/100)"));
  assert.ok(md.includes("@alice, @bob"));
  assert.ok(md.includes("NO")); // safe_to_merge false
});

test("mock data renders a loud warning banner", () => {
  const md = renderReportMarkdown(
    sampleReport({ data_source: "mock-fallback", is_real_data: false })
  );
  assert.ok(md.includes("MOCK DATA"));
});

test("postReportComment creates a note when none exists", async () => {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET" });
    if ((opts.method || "GET") === "GET") {
      return { ok: true, json: async () => [] };
    }
    return { ok: true, json: async () => ({ id: 1 }) };
  };
  process.env.GITLAB_TOKEN = "test-token";

  const res = await postReportComment(sampleReport(), {
    projectId: "123",
    mrIid: 7,
  });
  assert.equal(res.ok, true);
  assert.equal(res.action, "created");
  assert.equal(calls.some((c) => c.method === "POST"), true);
});

test("postReportComment updates an existing GitPulse note", async () => {
  globalThis.fetch = async (url, opts = {}) => {
    if ((opts.method || "GET") === "GET") {
      return {
        ok: true,
        json: async () => [{ id: 99, body: `${REPORT_MARKER}\nold` }],
      };
    }
    return { ok: true, json: async () => ({ id: 99 }) };
  };
  process.env.GITLAB_TOKEN = "test-token";

  const res = await postReportComment(sampleReport(), {
    projectId: "123",
    mrIid: 7,
  });
  assert.equal(res.ok, true);
  assert.equal(res.action, "updated");
});

test("postReportComment skips cleanly without a token or iid", async () => {
  delete process.env.GITLAB_TOKEN;
  delete process.env.ORBIT_TOKEN;
  delete process.env.GITLAB_API_TOKEN;
  delete process.env.CI_JOB_TOKEN;
  const res = await postReportComment(sampleReport(), {
    projectId: "123",
    mrIid: 7,
  });
  assert.equal(res.ok, false);
  assert.equal(res.action, "skipped");
});
