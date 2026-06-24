/**
 * GitLab Integration via Orbit Knowledge Graph
 * Queries Orbit for open merge requests and CI/CD pipelines
 * related to a set of files.
 *
 * Uses `glab orbit remote query` for real data.
 * Falls back to mock data if Orbit is unavailable.
 *
 * GitLab API docs: https://docs.gitlab.com/ee/api/merge_requests.html
 * Orbit docs: https://docs.gitlab.com/ee/user/ai_features/orbit/
 */

import { queryOrbit } from "./orbit-client.js";
import { apiBaseUrl, authHeaders } from "./gitlab-api.js";

/**
 * Fetch the merge-conflict status for a single MR via the GitLab REST API.
 * Best-effort: returns an empty object when auth is unavailable or the call
 * fails, so a missing signal never breaks the report.
 *
 * @param {string} projectId
 * @param {number|string} mrIid
 * @returns {Promise<{has_conflicts?: boolean, merge_status?: string}>}
 */
async function checkMergeConflicts(projectId, mrIid) {
  const headers = authHeaders();
  if (!headers || !projectId || !mrIid) return {};
  try {
    const url = `${apiBaseUrl()}/projects/${encodeURIComponent(
      projectId
    )}/merge_requests/${mrIid}`;
    const res = await fetch(url, { headers });
    if (!res.ok) return {};
    const mr = await res.json();
    return {
      has_conflicts: mr.has_conflicts === true,
      merge_status: mr.detailed_merge_status || mr.merge_status,
    };
  } catch {
    return {};
  }
}

/**
 * Annotate each open MR with its merge-conflict signal. Runs the per-MR
 * lookups in parallel and tolerates partial failures.
 *
 * @param {object[]} mrs
 * @param {string} projectId
 * @returns {Promise<object[]>}
 */
async function enrichOpenMRsWithConflicts(mrs, projectId) {
  if (!Array.isArray(mrs) || mrs.length === 0) return mrs;
  return Promise.all(
    mrs.map(async (mr) => {
      const conflict = await checkMergeConflicts(projectId, mr.id);
      return { ...mr, ...conflict };
    })
  );
}

/**
 * Find open merge requests that touch any of the specified files.
 * Uses Orbit's MergeRequest → MergeRequestDiff → MergeRequestDiffFile
 * traversal to find MRs with file overlap.
 *
 * @param {string[]} files - List of file paths to check
 * @param {string} projectId - GitLab project ID
 * @returns {Promise<object[]>} Array of MR objects with overlap info
 */
export async function gitlabGetOpenMRs(files, projectId) {
  console.log(
    `    [GitLab] Searching open MRs for ${files.length} files in project ${projectId}`
  );

  // Attempt real Orbit query for open MRs
  const orbitResult = await queryOrbitOpenMRs(files, projectId);

  if (orbitResult) {
    console.log(`    [GitLab] ✓ Real MR data from Orbit`);
    return enrichOpenMRsWithConflicts(orbitResult, projectId);
  }

  // Fallback to mock data
  console.log(`    [GitLab] Using mock MR data (fallback)`);
  return getMockOpenMRs(files, projectId);
}

/**
 * Get CI/CD pipeline configurations that include the specified files.
 * Uses Orbit's Pipeline entity to find pipelines for the project.
 *
 * @param {string[]} files - List of file paths to check for pipeline coverage
 * @returns {Promise<object[]>} Array of pipeline config objects
 */
export async function gitlabGetPipelines(files) {
  console.log(
    `    [GitLab] Looking up CI/CD pipelines for ${files.length} files`
  );

  // Attempt real Orbit query for pipelines
  const orbitResult = await queryOrbitPipelines(files);

  if (orbitResult) {
    console.log(`    [GitLab] ✓ Real pipeline data from Orbit`);
    return orbitResult;
  }

  // Fallback to mock data
  console.log(`    [GitLab] Using mock pipeline data (fallback)`);
  return getMockPipelines(files);
}

// ─── Real Orbit Queries ─────────────────────────────────────────

/**
 * Query Orbit for open MRs that touch the given files.
 * Uses HAS_DIFF → HAS_FILE traversal per Orbit recipes.
 */
async function queryOrbitOpenMRs(files, projectId) {
  // Query for each file (batch up to 5 to respect iteration budget)
  const allMRs = new Map(); // keyed by MR iid to deduplicate

  // Match files by basename so a diff file path like "src/orbit.js" overlaps
  // a target "orbit.js". Build the set once.
  const targetBaseNames = new Set(
    files.map((f) => f.split("/").pop())
  );

  // Single traversal: open MRs in this project and their changed files.
  // Use default columns (an explicit allowlist is rejected by the API) and
  // the {op:"eq"} filter form verified against the live graph.
  const query = {
    query_type: "traversal",
    nodes: [
      {
        id: "mr",
        entity: "MergeRequest",
        filters: {
          state: { op: "eq", value: "opened" },
          project_id: { op: "eq", value: parseInt(projectId, 10) },
        },
      },
      { id: "diff", entity: "MergeRequestDiff" },
      { id: "f", entity: "MergeRequestDiffFile" },
    ],
    relationships: [
      { type: "HAS_DIFF", from: "mr", to: "diff" },
      { type: "HAS_FILE", from: "diff", to: "f" },
    ],
    limit: 500,
  };

  const result = await queryOrbit(query);
  if (!result) return null; // Fall back entirely

  // The graph response interleaves MergeRequest, MergeRequestDiff and
  // MergeRequestDiffFile nodes plus HAS_DIFF/HAS_FILE edges. Reconstruct which
  // files belong to which MR, then keep MRs that touch a target file.
  const raw = result.result || result;
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const edges = Array.isArray(raw.edges) ? raw.edges : [];

  const mrById = new Map();
  const diffToMr = new Map();   // MergeRequestDiff id -> MergeRequest id
  const fileById = new Map();   // MergeRequestDiffFile id -> {old_path,new_path}
  const fileToDiff = new Map(); // MergeRequestDiffFile id -> MergeRequestDiff id

  for (const n of nodes) {
    if (n.type === "MergeRequest") mrById.set(String(n.id), n);
    else if (n.type === "MergeRequestDiffFile") {
      fileById.set(String(n.id), n);
    }
  }
  for (const e of edges) {
    if (e.type === "HAS_DIFF") diffToMr.set(String(e.to_id), String(e.from_id));
    else if (e.type === "HAS_FILE") fileToDiff.set(String(e.to_id), String(e.from_id));
  }

  // For each changed file, resolve its MR and record overlap if it matches.
  for (const [fileId, fnode] of fileById) {
    const path = fnode.old_path || fnode.new_path || "";
    const base = path.split("/").pop();
    if (!base || !targetBaseNames.has(base)) continue;

    const diffId = fileToDiff.get(fileId);
    const mrId = diffId && diffToMr.get(diffId);
    const mr = mrId && mrById.get(mrId);
    if (!mr) continue;

    const iid = mr.iid || mr.id;
    if (!allMRs.has(iid)) {
      allMRs.set(iid, {
        id: iid,
        title: mr.title || `MR !${iid}`,
        author: "@unknown",
        url:
          mr.web_url ||
          `https://gitlab.com/gitlab-ai-hackathon/transcend/35602696/-/merge_requests/${iid}`,
        state: "opened",
        source_branch: mr.source_branch,
        overlap: [base],
      });
    } else {
      const existing = allMRs.get(iid);
      if (!existing.overlap.includes(base)) existing.overlap.push(base);
    }
  }

  return Array.from(allMRs.values());
}

/**
 * Query Orbit for recent pipelines in the project.
 */
async function queryOrbitPipelines(files) {
  // Use a single pipeline query — find recent pipelines
  // We infer pipeline risk from the files' directory structure
  const query = {
    query_type: "traversal",
    node: {
      id: "p",
      entity: "Pipeline",
      columns: ["id", "status", "ref", "source", "created_at"],
      filters: {
        source: { op: "eq", value: "merge_request_event" },
      },
    },
    order_by: { node: "p", property: "created_at", direction: "DESC" },
    limit: 10,
  };

  const result = await queryOrbit(query);
  if (!result) return null;

  const rows = extractRows(result);
  if (rows.length === 0) return null;

  // Return the real recent pipelines from the graph (most recent first),
  // de-duplicated by id. No path-based name inference.
  const pipelines = [];
  const seen = new Set();
  for (const row of rows) {
    const id = row.id || row.p_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const ref = row.ref || row.p_ref || "unknown";
    pipelines.push({
      name: `pipeline #${row.iid || id} (${ref})`,
      last_status: row.status || row.p_status || "unknown",
      ref,
      source: "orbit-remote",
    });
  }

  return pipelines.length > 0 ? pipelines : null;
}

// ─── Response Parsing ───────────────────────────────────────────

function extractRows(result) {
  if (!result) return [];
  if (typeof result === "string") {
    try { return extractRows(JSON.parse(result)); } catch { return []; }
  }
  // Graph-shaped response from `glab orbit remote query --format raw`.
  if (result.result && Array.isArray(result.result.nodes)) {
    return result.result.nodes.map(flattenNode);
  }
  if (Array.isArray(result.nodes)) return result.nodes.map(flattenNode);
  // Tabular shapes.
  if (Array.isArray(result.rows)) return result.rows.map(flattenNode);
  if (result.data && Array.isArray(result.data.rows)) return result.data.rows.map(flattenNode);
  if (result.data && Array.isArray(result.data)) return result.data.map(flattenNode);
  if (result.response) return extractRows(result.response);
  return [];
}

/**
 * Flatten an Orbit node/row into a plain property map, exposing both the
 * original (possibly alias-prefixed) key and the bare property name.
 */
function flattenNode(node) {
  if (!node || typeof node !== "object") return {};
  const out = {};
  const props = node.properties && typeof node.properties === "object"
    ? { ...node, ...node.properties }
    : node;
  for (const [key, value] of Object.entries(props)) {
    if (key === "properties") continue;
    out[key] = value;
    const underscore = key.indexOf("_");
    if (underscore > 0) {
      const bare = key.slice(underscore + 1);
      if (!(bare in out)) out[bare] = value;
    }
  }
  return out;
}

function inferPipelineFromPath(file) {
  if (file.includes("checkout")) return "checkout-service-ci";
  if (file.includes("invoic")) return "invoice-gen-ci";
  if (file.includes("report")) return "reports-ci";
  if (file.includes("auth")) return "auth-service-ci";
  if (file.includes("api")) return "api-gateway-ci";
  return null;
}

// ─── Mock Data Fallback ─────────────────────────────────────────

function getMockOpenMRs(files, projectId) {
  const mockMRs = [
    {
      id: 234,
      title: "Add EU tax rates",
      author: "@alice",
      url: `https://gitlab.com/project/${projectId}/-/merge_requests/234`,
      state: "opened",
      created_at: "2025-06-15T10:30:00Z",
      source_branch: "feature/eu-tax-rates",
      files_changed: [
        "src/checkout/CartService.js",
        "src/checkout/CheckoutFlow.jsx",
        "utils/tax.js",
      ],
    },
    {
      id: 289,
      title: "Refactor invoice generation",
      author: "@bob",
      url: `https://gitlab.com/project/${projectId}/-/merge_requests/289`,
      state: "opened",
      created_at: "2025-06-18T14:15:00Z",
      source_branch: "refactor/invoice-gen",
      files_changed: [
        "src/invoicing/InvoiceGen.js",
        "src/invoicing/PDFExport.js",
        "src/invoicing/EmailSender.js",
      ],
    },
    {
      id: 312,
      title: "Update monthly report template",
      author: "@carol",
      url: `https://gitlab.com/project/${projectId}/-/merge_requests/312`,
      state: "opened",
      created_at: "2025-06-20T09:45:00Z",
      source_branch: "fix/report-template",
      files_changed: [
        "src/reports/MonthlyReport.js",
        "src/reports/TaxSummary.js",
      ],
    },
  ];

  return mockMRs
    .map((mr) => {
      const overlap = files.filter((f) => mr.files_changed.includes(f));
      if (overlap.length === 0) return null;
      return {
        id: mr.id,
        title: mr.title,
        author: mr.author,
        url: mr.url,
        state: mr.state,
        created_at: mr.created_at,
        source_branch: mr.source_branch,
        overlap,
      };
    })
    .filter(Boolean);
}

function getMockPipelines(files) {
  const pipelineMap = {
    checkout: {
      name: "checkout-service-ci",
      config_path: ".gitlab/ci/checkout.yml",
      stages: ["lint", "test", "build", "deploy-staging"],
      last_status: "success",
    },
    invoic: {
      name: "invoice-gen-ci",
      config_path: ".gitlab/ci/invoicing.yml",
      stages: ["lint", "test", "build", "deploy-staging"],
      last_status: "success",
    },
    report: {
      name: "reports-ci",
      config_path: ".gitlab/ci/reports.yml",
      stages: ["lint", "test", "build"],
      last_status: "success",
    },
    auth: {
      name: "auth-service-ci",
      config_path: ".gitlab/ci/auth.yml",
      stages: ["lint", "test", "security-scan", "build", "deploy-staging"],
      last_status: "success",
    },
    api: {
      name: "api-gateway-ci",
      config_path: ".gitlab/ci/api.yml",
      stages: ["lint", "test", "integration-test", "build"],
      last_status: "failed",
    },
  };

  const matchedPipelines = new Map();
  for (const file of files) {
    for (const [pattern, pipeline] of Object.entries(pipelineMap)) {
      if (file.includes(pattern) && !matchedPipelines.has(pipeline.name)) {
        matchedPipelines.set(pipeline.name, {
          ...pipeline,
          triggered_by_files: files.filter((f) => f.includes(pattern)),
        });
      }
    }
  }

  return Array.from(matchedPipelines.values());
}
