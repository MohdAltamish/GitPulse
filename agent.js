/**
 * GitPulse Agent — Blast Radius Analyzer
 * Uses Claude (claude-sonnet-4-6) to reason about dependency graphs
 * and produce structured blast radius reports.
 */

import Anthropic from "@anthropic-ai/sdk";
import { orbitQueryDependents, orbitGetOwners } from "./orbit.js";
import { gitlabGetOpenMRs, gitlabGetPipelines } from "./gitlab.js";
import { buildReport, calculateRiskScore } from "./report.js";

const client = new Anthropic();

const SYSTEM_PROMPT = `You are GitPulse, a blast radius analyzer for GitLab repositories.

Your job is to help developers understand the full impact of a code change before they merge.
Given a target file or function, you will analyze the dependency graph and produce a structured report.

You have access to these tools:
- orbit_query_dependents: Find all files that import/depend on the target
- orbit_get_owners: Map files to their owning teams/users
- gitlab_get_open_mrs: Find open MRs touching related files
- gitlab_get_pipelines: Identify CI/CD pipelines at risk

Always:
1. Traverse at least depth=2 (direct + transitive dependents)
2. Map every discovered file to an owner (mark unknown if not found)
3. Check for overlapping open MRs
4. Calculate a risk score and justify it
5. Suggest specific reviewers from the affected team owners

Be precise and complete. A missed dependency could cause a production incident.`;

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
 * Execute a tool call from the agent
 */
async function executeTool(toolName, toolInput, projectId) {
  switch (toolName) {
    case "orbit_query_dependents":
      return await orbitQueryDependents(
        toolInput.file,
        toolInput.symbol,
        toolInput.depth || 3
      );

    case "orbit_get_owners":
      return await orbitGetOwners(toolInput.files);

    case "gitlab_get_open_mrs":
      return await gitlabGetOpenMRs(
        toolInput.files,
        toolInput.project_id || projectId
      );

    case "gitlab_get_pipelines":
      return await gitlabGetPipelines(toolInput.files);

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

/**
 * Main agent loop — runs until the model produces a final report
 */
export async function runBlastRadiusAgent(file, symbol, projectId) {
  const userMessage = symbol
    ? `Analyze the blast radius of changing the \`${symbol}\` function in \`${file}\`. Project ID: ${projectId}`
    : `Analyze the blast radius of changing the file \`${file}\`. Project ID: ${projectId}`;

  const messages = [{ role: "user", content: userMessage }];

  console.log(`\n🔍 GitPulse analyzing: ${file}${symbol ? `::${symbol}` : ""}`);
  console.log("━".repeat(60));

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
          const result = await executeTool(block.name, block.input, projectId);
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

  // Extract final text response
  const finalText = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return { report: finalText, messages };
}
