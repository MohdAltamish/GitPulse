#!/usr/bin/env node

/**
 * GitPulse CLI — Blast Radius Analyzer
 *
 * Usage:
 *   node cli.js --file utils/tax.js --function calculateTax
 *   node cli.js --file src/auth/AuthService.js --project-id 12345
 *   node cli.js --file utils/tax.js --format json
 *
 * Environment Variables:
 *   ANTHROPIC_API_KEY  — Required for Claude agent
 *   GITLAB_TOKEN       — Required for real GitLab API calls
 *   GITLAB_PROJECT_ID  — Default project ID (can override with --project-id)
 */

import "dotenv/config";
import { runBlastRadiusAgent } from "./agent.js";
import { postReportComment } from "./mr-comment.js";

/** Rank risk levels so --fail-on can compare thresholds. */
const RISK_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3 };

// ─── Arg Parsing ────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    file: null,
    function: null,
    projectId: process.env.GITLAB_PROJECT_ID || null,
    format: "text", // "text" or "json"
    requireOrbit: false, // hard-fail if data_source != orbit-remote
    failOn: null, // "LOW" | "MEDIUM" | "HIGH" => exit 1 at/above this risk
    strict: false, // exit 1 when safe_to_merge is false
    comment: false, // post the report as an MR note
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--file":
      case "-f":
        args.file = argv[++i];
        break;
      case "--function":
      case "--symbol":
      case "-s":
        args.function = argv[++i];
        break;
      case "--project-id":
      case "--project":
      case "-p":
        args.projectId = argv[++i];
        break;
      case "--format":
        args.format = argv[++i];
        break;
      case "--json":
        args.format = "json";
        break;
      case "--require-orbit":
        args.requireOrbit = true;
        break;
      case "--fail-on":
        args.failOn = String(argv[++i] || "").toUpperCase();
        break;
      case "--strict":
        args.strict = true;
        break;
      case "--comment":
        args.comment = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        // If no flag prefix, treat first positional as file
        if (!argv[i].startsWith("-") && !args.file) {
          args.file = argv[i];
        }
        break;
    }
  }

  return args;
}

function printHelp() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                  GitPulse — Blast Radius Analyzer           ║
║          "Before you push, know what breaks."               ║
╚══════════════════════════════════════════════════════════════╝

USAGE:
  node cli.js --file <path> [options]
  npm run analyze -- --file <path> [options]

OPTIONS:
  --file, -f <path>          File to analyze (required)
  --function, --symbol, -s   Specific function/symbol to trace
  --project-id, -p <id>      GitLab project ID (or set GITLAB_PROJECT_ID)
  --format <text|json>       Output format (default: text)
  --json                     Shorthand for --format json
  --require-orbit            Exit non-zero unless data came from the real Orbit graph
  --fail-on <LOW|MED|HIGH>   Exit non-zero when risk is at/above this level
  --strict                   Exit non-zero when safe_to_merge is false
  --comment                  Post the report as a note on the current MR (CI)
  --help, -h                 Show this help message

EXAMPLES:
  # Analyze a specific function
  node cli.js --file utils/tax.js --function calculateTax

  # Analyze an entire file
  node cli.js --file src/auth/AuthService.js

  # JSON output for CI integration
  node cli.js --file utils/tax.js --format json

  # With explicit project ID
  node cli.js --file utils/tax.js -p 12345

ENVIRONMENT:
  ANTHROPIC_API_KEY   Claude API key (required)
  GITLAB_TOKEN        GitLab access token
  GITLAB_PROJECT_ID   Default project ID
  ORBIT_API_URL       Orbit API base URL
`);
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Validate required args
  if (!args.file) {
    console.error("❌ Error: --file is required.\n");
    console.error("Usage: node cli.js --file <path> [--function <name>]\n");
    console.error("Run `node cli.js --help` for full usage information.");
    process.exit(1);
  }

  if (!args.projectId) {
    console.error(
      "❌ Error: Project ID is required. Use --project-id or set GITLAB_PROJECT_ID.\n"
    );
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(
      "ℹ️  ANTHROPIC_API_KEY not set — running deterministic analysis without the LLM."
    );
    console.log(
      "   (Set ANTHROPIC_API_KEY to enable the model-driven agent loop.)\n"
    );
  }

  // Run the agent
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║                  GitPulse — Blast Radius Analyzer           ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  try {
    const { report, reportObject } = await runBlastRadiusAgent(
      args.file,
      args.function,
      args.projectId
    );

    if (args.format === "json") {
      // Serialize the structured report object directly.
      console.log(JSON.stringify(reportObject, null, 2));
    } else {
      console.log(report);
    }

    console.log("\n" + "━".repeat(60));
    console.log("✨ Analysis complete.");

    // ── Optional MR comment (CI integration) ──────────────────────
    if (args.comment) {
      const mrIid = process.env.CI_MERGE_REQUEST_IID;
      const result = await postReportComment(reportObject, {
        projectId: args.projectId,
        mrIid,
      });
      if (result.ok) {
        console.log(`💬 MR comment ${result.action}.`);
      } else {
        console.warn(`⚠️  MR comment ${result.action}: ${result.reason}`);
      }
    }

    // ── Enforcing gates (exit codes change reviewer behavior) ──────
    if (args.requireOrbit && reportObject.data_source !== "orbit-remote") {
      console.error(
        `\n❌ --require-orbit set but data_source was "${reportObject.data_source}". Real Orbit graph data was not available.`
      );
      process.exit(1);
    }

    if (args.strict && reportObject.safe_to_merge === false) {
      console.error("\n❌ --strict: report is not safe_to_merge.");
      process.exit(1);
    }

    if (args.failOn && RISK_RANK[args.failOn]) {
      if (RISK_RANK[reportObject.risk] >= RISK_RANK[args.failOn]) {
        console.error(
          `\n❌ --fail-on ${args.failOn}: risk is ${reportObject.risk}.`
        );
        process.exit(1);
      }
    }
  } catch (error) {
    console.error(`\n❌ GitPulse error: ${error.message}`);

    if (error.message.includes("API key")) {
      console.error("\nHint: Check that ANTHROPIC_API_KEY is set in your .env file.");
    }

    if (error.message.includes("rate limit")) {
      console.error("\nHint: You've hit the API rate limit. Wait a moment and try again.");
    }

    process.exit(1);
  }
}

main();
