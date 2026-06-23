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

// ─── Arg Parsing ────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    file: null,
    function: null,
    projectId: process.env.GITLAB_PROJECT_ID || null,
    format: "text", // "text" or "json"
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
    console.error(
      "❌ Error: ANTHROPIC_API_KEY is not set. Add it to your .env file.\n"
    );
    console.error("  cp .env.example .env");
    console.error("  # Then fill in your Anthropic API key");
    process.exit(1);
  }

  // Run the agent
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║                  GitPulse — Blast Radius Analyzer           ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  try {
    const { report } = await runBlastRadiusAgent(
      args.file,
      args.function,
      args.projectId
    );

    if (args.format === "json") {
      // Try to extract JSON from the report text
      const jsonMatch = report.match(/```json\n([\s\S]*?)\n```/);
      if (jsonMatch) {
        // Pretty-print extracted JSON
        try {
          const parsed = JSON.parse(jsonMatch[1]);
          console.log(JSON.stringify(parsed, null, 2));
        } catch {
          console.log(jsonMatch[1]);
        }
      } else {
        // If no JSON block found, output the raw report
        console.log(report);
      }
    } else {
      console.log(report);
    }

    console.log("\n" + "━".repeat(60));
    console.log("✨ Analysis complete.");
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
