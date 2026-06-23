/**
 * GitLab Orbit Knowledge Graph Integration
 * Queries the Orbit graph for dependency traversal and file ownership.
 *
 * Uses `glab orbit remote query` for real Orbit API calls.
 * Falls back to mock data if Orbit is unavailable.
 *
 * Orbit API docs: https://docs.gitlab.com/ee/user/ai_features/orbit/
 */

import { queryOrbit } from "./orbit-client.js";
import { staticAnalyzeDependents } from "./static-analysis.js";

/**
 * Query Orbit for all files that depend on the target file/symbol.
 * Returns direct and transitive dependents up to `depth` levels.
 *
 * Uses Orbit's ImportedSymbol and Definition entities to trace the
 * dependency graph via the knowledge graph.
 *
 * @param {string} file - Relative file path
 * @param {string|null} symbol - Optional function/class name
 * @param {number} depth - Traversal depth (1-5, default 3)
 * @returns {Promise<object>} Dependency graph
 */
export async function orbitQueryDependents(file, symbol = null, depth = 3) {
  console.log(
    `    [Orbit] Querying dependents for ${file}${symbol ? `::${symbol}` : ""} (depth=${depth})`
  );

  // Attempt real Orbit query
  const orbitResult = await queryOrbitDependents(file, symbol);

  if (orbitResult) {
    console.log(`    [Orbit] ✓ Real graph data returned`);
    return orbitResult;
  }

  // Fallback 1: real static import analysis of the repo on disk. This yields a
  // genuinely correct graph even when Orbit is unavailable.
  const staticResult = await staticAnalyzeDependents(file, symbol, depth);
  if (staticResult) {
    console.log(
      `    [Orbit] ⚠️ Orbit unavailable — using real static import analysis (${staticResult.metadata.scanned_files} files scanned)`
    );
    return staticResult;
  }

  // Fallback 2: labelled mock data (last resort — clearly marked as mock).
  console.log(`    [Orbit] ⚠️ Static analysis unavailable — using MOCK dependency data (fallback)`);
  return getMockDependencyGraph(file, symbol);
}

/**
 * Get team/user ownership for a list of files.
 * Uses Orbit to find recent MR authors who touched each file.
 *
 * @param {string[]} files - List of file paths
 * @returns {Promise<object[]>} Ownership data
 */
export async function orbitGetOwners(files) {
  console.log(`    [Orbit] Looking up owners for ${files.length} files`);

  // Attempt real Orbit ownership lookup
  const orbitResult = await queryOrbitOwners(files);

  if (orbitResult) {
    console.log(`    [Orbit] ✓ Real ownership data returned`);
    return orbitResult;
  }

  // Fallback to mock data
  console.log(`    [Orbit] Using mock ownership data (fallback)`);
  return files.map((file) => ({
    file,
    team: inferTeamFromPath(file),
    owner: inferOwnerFromPath(file),
    last_committer: inferOwnerFromPath(file),
    codeowners_match: `*/${file.split("/")[1]}/**`,
    ownership_basis: "inferred-from-path",
  }));
}

// ─── Real Orbit Queries ─────────────────────────────────────────

/**
 * Query Orbit for files that import the target file.
 * Uses ImportedSymbol entity to find import relationships.
 */
async function queryOrbitDependents(file, symbol) {
  // Extract filename without extension for import matching
  const fileBaseName = file.replace(/\.[jt]sx?$/, "").split("/").pop();
  const filePath = file;

  // Query 1: Find files that import this module via ImportedSymbol
  const importQuery = {
    query_type: "traversal",
    node: {
      id: "imp",
      entity: "ImportedSymbol",
      filters: {
        import_path: { op: "contains", value: fileBaseName },
      },
      columns: ["file_path", "import_path", "name"],
    },
    limit: 100,
  };

  const importResult = await queryOrbit(importQuery);

  if (!importResult) return null;

  // Parse the Orbit response into our dependency graph format
  const directDeps = [];
  const seenFiles = new Set();

  // Process import results
  const rows = extractRows(importResult);
  for (const row of rows) {
    const depFile = row.file_path || row.imp_file_path;
    if (depFile && !seenFiles.has(depFile) && depFile !== filePath) {
      seenFiles.add(depFile);
      directDeps.push({
        file: depFile,
        import_type: "named",
        import_path: row.import_path || row.imp_import_path || file,
        depth: 1,
      });
    }
  }

  // Query 2: If we have direct dependents, find their importers (depth 2)
  const transitiveDeps = [];
  if (directDeps.length > 0 && directDeps.length <= 20) {
    for (const dep of directDeps.slice(0, 5)) {
      const depBaseName = dep.file.replace(/\.[jt]sx?$/, "").split("/").pop();
      const transitiveQuery = {
        query_type: "traversal",
        node: {
          id: "imp2",
          entity: "ImportedSymbol",
          filters: {
            import_path: { op: "contains", value: depBaseName },
          },
          columns: ["file_path", "import_path"],
        },
        limit: 20,
      };

      const transitiveResult = await queryOrbit(transitiveQuery);
      if (transitiveResult) {
        const tRows = extractRows(transitiveResult);
        for (const row of tRows) {
          const tFile = row.file_path || row.imp2_file_path;
          if (tFile && !seenFiles.has(tFile) && tFile !== filePath) {
            seenFiles.add(tFile);
            transitiveDeps.push({
              file: tFile,
              via: dep.file,
              depth: 2,
            });
          }
        }
      }
    }
  }

  return {
    target: { file, symbol },
    direct: directDeps,
    transitive: transitiveDeps,
    metadata: {
      total_dependents: directDeps.length + transitiveDeps.length,
      max_depth_reached: transitiveDeps.length > 0 ? 2 : 1,
      graph_complete: true,
      source: "orbit-remote",
      orbit_version: "live",
    },
  };
}

/**
 * Query Orbit for file ownership by finding recent MR authors
 * who touched each file.
 */
async function queryOrbitOwners(files) {
  const results = [];

  // Batch files to avoid too many queries (Orbit iteration budget)
  for (const file of files.slice(0, 10)) {
    const ownerQuery = {
      query_type: "traversal",
      nodes: [
        {
          id: "mr",
          entity: "MergeRequest",
          columns: ["iid", "title", "state"],
          filters: { state: { op: "in", value: ["merged", "opened"] } },
        },
        { id: "diff", entity: "MergeRequestDiff" },
        {
          id: "f",
          entity: "MergeRequestDiffFile",
          filters: { old_path: { op: "ends_with", value: file } },
        },
        {
          id: "author",
          entity: "User",
          columns: ["username", "name"],
        },
      ],
      relationships: [
        { type: "HAS_DIFF", from: "mr", to: "diff" },
        { type: "HAS_FILE", from: "diff", to: "f" },
        { type: "AUTHORED", from: "author", to: "mr" },
      ],
      limit: 5,
    };

    const ownerResult = await queryOrbit(ownerQuery);

    if (!ownerResult) return null; // Fall back entirely

    const rows = extractRows(ownerResult);
    if (rows.length > 0) {
      const firstRow = rows[0];
      const username = firstRow.username || firstRow.author_username || "unknown";
      results.push({
        file,
        team: inferTeamFromPath(file),
        owner: `@${username}`,
        last_committer: `@${username}`,
        codeowners_match: null,
        source: "orbit-remote",
        ownership_basis: "mr-authorship",
      });
    } else {
      // No MR history found — mark ownership as unknown (AGENTS.md guardrail)
      results.push({
        file,
        team: inferTeamFromPath(file),
        owner: "@unknown",
        last_committer: "@unknown",
        codeowners_match: null,
        source: "orbit-remote",
        ownership: "unknown",
        ownership_basis: "unknown",
      });
    }
  }

  return results;
}

// ─── Response Parsing ───────────────────────────────────────────

/**
 * Extract row data from Orbit's response format.
 *
 * `glab orbit remote query --format raw` returns a graph-shaped response:
 *   { result: { nodes: [ { id, type, <properties...> }, ... ], edges: [...] } }
 * (see .agents/skills/orbit/references/query_language.md). Older/alternate
 * shapes use { rows: [...] }. We normalize all of them to a flat array of
 * property objects, flattening any alias-prefixed columns (e.g. imp_file_path
 * -> file_path) so callers can read bare property names.
 */
function extractRows(result) {
  if (!result) return [];

  // LLM/string format — try to parse it first.
  if (typeof result === "string") {
    try {
      return extractRows(JSON.parse(result));
    } catch {
      return [];
    }
  }

  // Graph shape: { result: { nodes: [...] } }
  if (result.result && Array.isArray(result.result.nodes)) {
    return result.result.nodes.map(flattenNode);
  }
  // Graph shape without the `result` envelope.
  if (Array.isArray(result.nodes)) {
    return result.nodes.map(flattenNode);
  }

  // Tabular shapes: { rows: [...] } / { data: { rows: [...] } } / { data: [...] }
  if (Array.isArray(result.rows)) return result.rows.map(flattenNode);
  if (result.data && Array.isArray(result.data.rows)) return result.data.rows.map(flattenNode);
  if (result.data && Array.isArray(result.data)) return result.data.map(flattenNode);

  // Nested response envelope.
  if (result.response) return extractRows(result.response);

  return [];
}

/**
 * Flatten an Orbit node/row into a plain property map.
 *
 * Orbit may return alias-prefixed column names (e.g. `imp_file_path`,
 * `mr_iid`) when multiple nodes are present, alongside bare names. We expose
 * both: the bare property and the original key, so lookups like
 * `row.file_path` work regardless of which the server emitted.
 */
function flattenNode(node) {
  if (!node || typeof node !== "object") return {};
  const out = {};
  // Some raw responses nest values under a `properties` object.
  const props = node.properties && typeof node.properties === "object"
    ? { ...node, ...node.properties }
    : node;
  for (const [key, value] of Object.entries(props)) {
    if (key === "properties") continue;
    out[key] = value;
    // Strip a leading alias segment: `imp_file_path` -> `file_path`.
    const underscore = key.indexOf("_");
    if (underscore > 0) {
      const bare = key.slice(underscore + 1);
      if (!(bare in out)) out[bare] = value;
    }
  }
  return out;
}

// ─── Mock Data Fallback ─────────────────────────────────────────

function getMockDependencyGraph(file, symbol) {
  return {
    target: { file, symbol },
    direct: [
      {
        file: "src/checkout/CartService.js",
        import_type: "named",
        import_path: `../../${file}`,
        depth: 1,
      },
      {
        file: "src/invoicing/InvoiceGen.js",
        import_type: "named",
        import_path: `../../${file}`,
        depth: 1,
      },
      {
        file: "src/reports/TaxSummary.js",
        import_type: "named",
        import_path: `../../${file}`,
        depth: 1,
      },
    ],
    transitive: [
      { file: "src/checkout/CheckoutFlow.jsx", via: "src/checkout/CartService.js", depth: 2 },
      { file: "src/checkout/OrderConfirmation.jsx", via: "src/checkout/CartService.js", depth: 2 },
      { file: "src/invoicing/PDFExport.js", via: "src/invoicing/InvoiceGen.js", depth: 2 },
      { file: "src/invoicing/EmailSender.js", via: "src/invoicing/InvoiceGen.js", depth: 2 },
      { file: "src/reports/MonthlyReport.js", via: "src/reports/TaxSummary.js", depth: 2 },
      { file: "src/api/CheckoutController.js", via: "src/checkout/CheckoutFlow.jsx", depth: 3 },
    ],
    metadata: {
      total_dependents: 9,
      max_depth_reached: 3,
      graph_complete: true,
      source: "mock-fallback",
      orbit_version: "mock",
    },
  };
}

function inferTeamFromPath(file) {
  if (file.includes("checkout")) return "team-checkout";
  if (file.includes("invoic")) return "team-finance";
  if (file.includes("report")) return "team-reports";
  if (file.includes("auth")) return "team-platform";
  if (file.includes("api")) return "team-backend";
  return "team-unknown";
}

function inferOwnerFromPath(file) {
  const teamMap = {
    checkout: "@alice",
    invoic: "@bob",
    report: "@carol",
    auth: "@dave",
    api: "@eve",
  };
  for (const [key, owner] of Object.entries(teamMap)) {
    if (file.includes(key)) return owner;
  }
  return "@unknown";
}
