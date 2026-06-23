/**
 * GitPulse Agent — Blast Radius Analyzer
 * Uses Claude (claude-sonnet-4-6) to orchestrate Orbit knowledge-graph
 * queries, then runs the deterministic scoring engine in report.js to
 * produce the structured blast radius report.
 *
 * The model decides WHICH files/symbols to investigate and drives the
 * tool calls; the final risk score, guardrails, and report shape are
 * computed deterministically by report.js so the SKILL.md formula and
 * AGENTS.md guardrails always execute the same way.
 */

import Anthropic from "@anthropic-ai/sdk";
import { orbitQueryDependents, orbitGetOwners } from "./orbit.js";
import { gitlabGetOpenMRs, gitlabGetPipelines } from "./gitlab.js";
import {
  buildReport,
  calculateRiskScore,
  formatReportForCLI,
} from "./report.js";

/**
 * Lazily construct the Anthropic client only when a key is available.
 * Constructing it unconditionally caused a hard failure (401 invalid x-api-key)
 * whenever ANTHROPIC_API_KEY was missing, even though the LLM is optional.
 * @returns {Anthropic|null}
 */
function getAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic();
}

const SYSTEM_PROMPT = `You are GitPulse, a blast radius analyzer for GitLab repositories.

Your job is to help developers understand the full impact of a code change before they merge.
Given a target file or function, you will analyze the dependency graph by calling the tools provided.

You have access to these tools:
- orbit_query_dependents: Find all files that import/depend on the target
- orbit_get_owners: Map files to their owning teams/users
- gitlab_get_open_mrs: Find open MRs touching related files
- gitlab_get_pipelines: Identify CI/CD pipelines at risk

Your required workflow:
1. Call orbit_query_dependents with depth >= 2 (direct + transitive dependents).
2. Collect the full list of affected files (direct + transitive) and call
   orbit_get_owners on ALL of them.
3. Call gitlab_get_open_mrs with the affected files and the project id.
4. Call gitlab_get_pipelines with the affected files.

Do NOT compute the risk score or write the final report yourself. Once you have
called all four tools, respond with a single short sentence confirming the
analysis is complete. GitPulse computes the risk score and renders the report
deterministically from the tool results.

HARD RULES (never violate):
- NEVER invent, recompute, restate, "normalize", "cap", or override the risk
  score or risk level. The only authoritative score/level is the one produced
  by calculateRiskScore in report.js and rendered by formatReportForCLI.
- NEVER present path-inferred or MR-authorship ownership as CODEOWNERS or as a
  graph-derived "team". If ownership came from MR authorship, say so explicitly.
- If you summarize, quote the report's numbers verbatim; do not derive new ones.`;

const TOOLS = [
  {
    name: "orbit_query_dependents",
    description:
      "Query GitLab Orbit knowledge graph to find all files/modules that depend on the target file or symbol. Returns direct and transitive dependents up to the specified depth.",
    input_schema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Relative file path (e.g. utils/tax.js)",
        },
        symbol: {
          type: "string",
          description: "Optional: specific function/class/export name",
        },
        depth: {
          type: "number",
          description: "Traversal depth 1-5 (default: 3)",
        },
      },
      required: ["file"],
    },
  },
  {
    name: "orbit_get_owners",
    description:
      "Get team and user ownership for a list of files using CODEOWNERS and Orbit enrichment.",
    input_schema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "List of file paths to look up ownership for",
        },
      },
      required: ["files"],
    },
  },
  {
    name: "gitlab_get_open_mrs",
    description:
      "Find open merge requests that touch any of the specified files.",
    input_schema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "List of file paths to check",
        },
        project_id: {
          type: "string",
          description: "GitLab project ID",
        },
      },
      required: ["files", "project_id"],
    },
  },
  {
    name: "gitlab_get_pipelines",
    description:
      "Get CI/CD pipeline configurations that include the specified files.",
    input_schema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "List of file paths to check for pipeline coverage",
        },
      },
      required: ["files"],
    },
  },
];

/**
 * Execute a tool call from the agent.
 *
 * `collected` accumulates the latest result from each tool so the
 * deterministic report engine can run after the agent loop finishes.
 */
async function executeTool(toolName, toolInput, projectId, collected) {
  switch (toolName) {
    case "orbit_query_dependents": {
      const graph = await orbitQueryDependents(
        toolInput.file,
        toolInput.symbol,
        toolInput.depth || 3
      );
      collected.graph = graph;
      return graph;
    }

    case "orbit_get_owners": {
      const owners = await orbitGetOwners(toolInput.files);
      // Merge so ownership discovered across multiple calls is retained.
      const byFile = new Map(collected.owners.map((o) => [o.file, o]));
      for (const o of owners) byFile.set(o.file, o);
      collected.owners = Array.from(byFile.values());
      return owners;
    }

    case "gitlab_get_open_mrs": {
      const mrs = await gitlabGetOpenMRs(
        toolInput.files,
        toolInput.project_id || projectId
      );
      collected.mrs = mrs;
      return mrs;
    }

    case "gitlab_get_pipelines": {
      const pipelines = await gitlabGetPipelines(toolInput.files);
      collected.pipelines = pipelines;
      return pipelines;
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

/**
 * Main agent loop — runs the model to drive tool calls, then computes the
 * report deterministically from the collected tool results.
 *
 * @returns {Promise<{ report: string, reportObject: object, messages: object[] }>}
 */
export async function runBlastRadiusAgent(file, symbol, projectId) {
  const userMessage = symbol
    ? `Analyze the blast radius of changing the \`${symbol}\` function in \`${file}\`. Project ID: ${projectId}`
    : `Analyze the blast radius of changing the file \`${file}\`. Project ID: ${projectId}`;

  const messages = [{ role: "user", content: userMessage }];

  console.log(`\n🔍 GitPulse analyzing: ${file}${symbol ? `::${symbol}` : ""}`);
  console.log("━".repeat(60));

  // Accumulates the latest result from each tool across the loop.
  const collected = {
    graph: null,
    owners: [],
    mrs: [],
    pipelines: [],
  };

  const client = getAnthropicClient();

  if (!client) {
    // ── Deterministic mode (no ANTHROPIC_API_KEY) ───────────────
    // The LLM only ever chose WHICH file to analyze; the CLI already provides
    // it. Run the four tools directly in the SKILL.md order so GitPulse works
    // fully offline / keyless. The scoring + report engine below is shared.
    console.log("  ℹ️  No ANTHROPIC_API_KEY — running deterministic analysis (no LLM).");
    await executeTool("orbit_query_dependents", { file, symbol, depth: 3 }, projectId, collected);
    const discovered = [
      ...(collected.graph?.direct || []).map((d) => d.file),
      ...(collected.graph?.transitive || []).map((d) => d.file),
    ];
    const ownerTargets = [file, ...discovered];
    await executeTool("orbit_get_owners", { files: ownerTargets }, projectId, collected);
    await executeTool("gitlab_get_open_mrs", { files: ownerTargets, project_id: projectId }, projectId, collected);
    await executeTool("gitlab_get_pipelines", { files: ownerTargets }, projectId, collected);
  } else {
    // ── LLM-driven mode (model orchestrates the same tools) ─────
    let response;
    let iteration = 0;
    const MAX_ITERATIONS = 10;

    while (iteration < MAX_ITERATIONS) {
      iteration++;

      response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      });

      // Add assistant response to history
      messages.push({ role: "assistant", content: response.content });

      // If model is done (no more tool calls), break
      if (response.stop_reason === "end_turn") {
        break;
      }

      // Process tool calls
      if (response.stop_reason === "tool_use") {
        const toolResults = [];

        for (const block of response.content) {
          if (block.type !== "tool_use") continue;

          console.log(`  → Calling ${block.name}...`);

          try {
            const result = await executeTool(
              block.name,
              block.input,
              projectId,
              collected
            );
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify(result),
            });
          } catch (error) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              is_error: true,
              content: `Error: ${error.message}`,
            });
          }
        }

        messages.push({ role: "user", content: toolResults });
      }
    }
  }

  // ── Deterministic report generation ───────────────────────────
  // Run the scoring engine from report.js so the SKILL.md formula and
  // AGENTS.md guardrails always execute, regardless of what the model said.
  const graph = collected.graph || { direct: [], transitive: [] };

  // Guardrail: ensure every discovered file has an ownership entry. If the
  // model never looked up owners (or missed some), resolve them now so files
  // are never silently dropped from the report.
  const allFiles = [
    ...(graph.direct || []).map((d) => d.file),
    ...(graph.transitive || []).map((d) => d.file),
  ];
  const ownedFiles = new Set(collected.owners.map((o) => o.file));
  const missingFiles = allFiles.filter((f) => !ownedFiles.has(f));
  if (missingFiles.length > 0) {
    const extraOwners = await orbitGetOwners(missingFiles);
    collected.owners = [...collected.owners, ...extraOwners];
  }

  const score = calculateRiskScore(
    graph,
    collected.owners,
    collected.mrs,
    collected.pipelines
  );

  const reportObject = buildReport({
    file,
    symbol: symbol || null,
    graph,
    owners: collected.owners,
    mrs: collected.mrs,
    pipelines: collected.pipelines,
    score,
  });

  const report = formatReportForCLI(reportObject);

  return { report, reportObject, messages };
}
