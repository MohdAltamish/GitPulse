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
    return orbitResult;
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

  for (const file of files.slice(0, 5)) {
    const query = {
      query_type: "traversal",
      nodes: [
        {
          id: "mr",
          entity: "MergeRequest",
          columns: ["iid", "title", "state", "web_url", "source_branch", "created_at"],
          filters: {
            state: "opened",
            project_id: { op: "eq", value: parseInt(projectId, 10) },
          },
        },
        { id: "diff", entity: "MergeRequestDiff" },
        {
          id: "f",
          entity: "MergeRequestDiffFile",
          filters: { old_path: { op: "ends_with", value: file } },
        },
      ],
      relationships: [
        { type: "HAS_DIFF", from: "mr", to: "diff" },
        { type: "HAS_FILE", from: "diff", to: "f" },
      ],
      limit: 20,
    };

    const result = await queryOrbit(query);
    if (!result) return null; // Fall back entirely

    const rows = extractRows(result);
    for (const row of rows) {
      const iid = row.iid || row.mr_iid;
      if (iid && !allMRs.has(iid)) {
        allMRs.set(iid, {
          id: iid,
          title: row.title || row.mr_title || `MR !${iid}`,
          author: row.author || "@unknown",
          url: row.web_url || row.mr_web_url || `https://gitlab.com/project/${projectId}/-/merge_requests/${iid}`,
          state: "opened",
          source_branch: row.source_branch || row.mr_source_branch,
          overlap: [file],
        });
      } else if (iid && allMRs.has(iid)) {
        // Same MR touches multiple files — extend overlap
        const existing = allMRs.get(iid);
        if (!existing.overlap.includes(file)) {
          existing.overlap.push(file);
        }
      }
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

  // Map files to inferred pipeline names and augment with real pipeline data
  const pipelines = [];
  const seenPatterns = new Set();

  for (const file of files) {
    const pipelineName = inferPipelineFromPath(file);
    if (pipelineName && !seenPatterns.has(pipelineName)) {
      seenPatterns.add(pipelineName);
      // Find a matching real pipeline if possible
      const matchingRow = rows.find(
        (r) => (r.ref || "").includes(pipelineName.split("-")[0])
      );
      pipelines.push({
        name: pipelineName,
        last_status: matchingRow ? matchingRow.status || "unknown" : "unknown",
        source: "orbit-remote",
        triggered_by_files: files.filter((f) => inferPipelineFromPath(f) === pipelineName),
      });
    }
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
