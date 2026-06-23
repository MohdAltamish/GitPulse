# GitPulse — Blast Radius Analyzer

> *"Before you push, know what breaks."*

GitPulse is an AI-powered agent built on the **GitLab Duo Agent Platform** that uses **GitLab Orbit's knowledge graph** to trace every dependent of a file or function you're about to change. It produces an instant **Blast Radius Report** complete with a deterministic risk score, affected owners, overlapping open MRs, at-risk pipelines, and suggested reviewers.

Built for the **GitLab Transcend Hackathon 2026** (Showcase Track).

---

## Table of Contents

- [The Problem](#the-problem)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [CLI Usage](#cli-usage)
- [Configuration](#configuration)
- [GitLab Orbit Integration](#gitlab-orbit-integration)
- [Data Provenance & Fallback](#data-provenance--fallback)
- [Risk Scoring](#risk-scoring)
- [Guardrails](#guardrails)
- [Report Schema](#report-schema)
- [Running in CI](#running-in-ci)
- [Project Structure](#project-structure)
- [Testing](#testing)
- [Publishing to AI Catalog](#publishing-to-ai-catalog)
- [How GitPulse Compares](#how-gitpulse-compares)
- [Hackathon](#hackathon)
- [License](#license)

---

## The Problem

A developer changes `calculateTax()` in `utils/tax.js`. Three days later, production breaks in a microservice nobody knew depended on it. The post-mortem always ends the same way: *"We didn't know that was connected."*

Manual dependency hunting takes 30+ minutes and still misses things. GitPulse makes it **seconds and complete** by querying Orbit's knowledge graph instead of grepping imports by hand.

---

## How It Works

GitPulse pairs an optional **Claude agent** (which decides *what* to investigate) with a **deterministic scoring engine** (which guarantees the risk formula and guardrails always execute the same way). When `ANTHROPIC_API_KEY` is set the model drives the tool calls; when it is absent GitPulse runs the same four tools deterministically with no LLM. Either way, `report.js` computes the final risk score and renders the report.

The analysis chain for every request:

1. **Parse** the target file and optional function/symbol.
2. **Traverse** dependents via Orbit's `ImportedSymbol` entity (direct + transitive, depth >= 2).
3. **Own** every discovered file by resolving authors from the `AUTHORED` edge (User -> MergeRequest).
4. **Correlate** in-flight changes by finding open MRs that overlap the affected files.
5. **Pipeline** assess CI/CD risk by querying Orbit's `Pipeline` entity.
6. **Score** the change with the deterministic formula in `report.js`.
7. **Report** a structured JSON object plus an emoji-rich CLI summary, tagged with its data provenance.
8. **Suggest** reviewers based on the ownership of affected code.

---

## Architecture

```
cli.js  ──→  agent.js (optional Claude loop, model: claude-sonnet-4-6)
                 │
                 │  runs four tools (LLM-driven OR deterministic), then report.js
                 │
                 ├── orbit.js          → dependency traversal + ownership
                 │     ├── orbit-client.js → Orbit REST client (POST /api/v4/orbit/query)
                 │     └── static-analysis.js → real import-graph fallback (no Orbit)
                 ├── gitlab.js         → open MRs + pipelines via Orbit
                 └── report.js         → deterministic scoring + report builder
```

- **`cli.js`** parses arguments, invokes the agent, and prints text or JSON output. It runs with or without an API key.
- **`agent.js`** runs the Claude loop with four tool definitions when a key is present, or executes the tools deterministically when it is not, then calls `report.js` so scoring never depends on what the model "decides" the risk is.
- **`orbit.js`** implements `orbitQueryDependents` and `orbitGetOwners`, with a real static-analysis fallback ahead of mock.
- **`gitlab.js`** implements `gitlabGetOpenMRs` and `gitlabGetPipelines`.
- **`orbit-client.js`** queries the Orbit REST API directly (no external binary required); `glab orbit remote query` is a secondary fallback for local dev.
- **`static-analysis.js`** parses real `import`/`export ... from` statements across the repo to build a true reverse-dependency graph when Orbit is unavailable.
- **`report.js`** holds `calculateRiskScore`, `buildReport`, and `formatReportForCLI`.

---

## Quick Start

```bash
# 1. Clone the repo
git clone https://gitlab.com/gitlab-ai-hackathon/transcend/35602696.git gitpulse
cd gitpulse

# 2. Install dependencies (only @anthropic-ai/sdk and dotenv)
npm install

# 3. (Optional) Set up environment for real Orbit data
cp .env.example .env
# Add GITLAB_TOKEN (api scope) for real Orbit queries.
# ANTHROPIC_API_KEY is OPTIONAL — without it GitPulse runs deterministically.

# 4. Run an analysis against this project
node cli.js --file orbit.js --project-id 83678311
```

Requires **Node.js 18+** (uses the built-in `node --test` runner, ESM modules, and global `fetch`).

---

## CLI Usage

```bash
node cli.js --file <path> [options]
npm run analyze -- --file <path> [options]
```

| Option | Aliases | Description |
|--------|---------|-------------|
| `--file <path>` | `-f` | File to analyze (**required**) |
| `--function <name>` | `--symbol`, `-s` | Specific function/symbol to trace |
| `--project-id <id>` | `--project`, `-p` | GitLab project ID (or set `GITLAB_PROJECT_ID`) |
| `--format <text\|json>` | | Output format (default: `text`) |
| `--json` | | Shorthand for `--format json` |
| `--help` | `-h` | Show help |

A bare positional argument is treated as the file path, so `node cli.js orbit.js -p 83678311` also works.

### Examples

```bash
# Analyze an entire file
node cli.js --file orbit.js --project-id 83678311

# Analyze a specific function
node cli.js --file utils/tax.js --function calculateTax --project-id 83678311

# JSON output for CI integration
node cli.js --file orbit.js --format json --project-id 83678311
```

### Example Output (real Orbit data)

```
📊 Blast Radius Report — orbit.js
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 Risk: HIGH (score: 100/100)
   3 dependents across 1 team. 3 open MRs touch related code.

📁 Direct Dependents (files that import this)
   ├── gitlab.js
   └── agent.js

🔗 Transitive Dependents (files that depend on those)
   └── cli.js (depth: 2, via: agent.js)

🔀 Open MRs Touching Related Code
   ├── !4 — "feat: maximize hackathon submission"
   ├── !7 — "feat: add orbit_get_graph_status tool"
   └── !9 — "fix: prevent risk-score drift"

✅ Suggested Reviewers
   └── @altamish6589 (owners of affected files)

📋 Safe to merge without notifying these teams? 🚫 NO
```

When Orbit is unreachable, the same report renders from real static import analysis, prefixed with an `ℹ️` provenance note; if even that is unavailable, a loud `⚠️ MOCK DATA` banner is shown and `safe_to_merge` is forced to `false`.

---

## Configuration

Copy `.env.example` to `.env` and fill in what you need. **All of these are optional** — GitPulse degrades gracefully without them.

| Variable | Required | Purpose |
|----------|----------|---------|
| `GITLAB_TOKEN` | for real Orbit data | GitLab PAT with `api` scope; sent as `PRIVATE-TOKEN` to the Orbit REST API |
| `ANTHROPIC_API_KEY` | optional | Enables the Claude-driven agent loop; without it GitPulse runs deterministically |
| `GITLAB_PROJECT_ID` | optional | Default project ID (overridable with `--project-id`) |
| `CI_API_V4_URL` / `GITLAB_API_URL` | optional | API base URL (defaults to `https://gitlab.com/api/v4`) |

In CI, `CI_API_V4_URL`, `CI_PROJECT_ID`, and `CI_JOB_TOKEN` are injected automatically. For reliable Orbit access add a masked `GITLAB_TOKEN` (api scope) CI/CD variable, the job token may be restricted for the Orbit endpoint.

---

## GitLab Orbit Integration

GitPulse queries Orbit over the **REST API** (`POST /api/v4/orbit/query`) in `orbit-client.js`. It sends `{ query, query_type: "json", response_format: "raw" }`, authenticates with `GITLAB_TOKEN` (or `CI_JOB_TOKEN`), and parses the graph-shaped response. No external binary is required; `glab orbit remote query` is only a local-dev fallback.

| Query | Orbit Entity | Relationship | Purpose |
|-------|-------------|-------------|---------|
| Find dependents | `ImportedSymbol` | `import_path` `contains` + `project_id` `eq` | Trace who imports the target file |
| Find owners | `User` → `MergeRequest` | `AUTHORED` | Map files to their authors (`ownership_basis: mr-authorship`) |
| Open MRs | `MergeRequest` → `MergeRequestDiff` → `MergeRequestDiffFile` | `HAS_DIFF`, `HAS_FILE` | Find open MRs touching the same files |
| Pipelines | `Pipeline` | `source` filter, `created_at` order | Identify recent at-risk CI/CD pipelines |

**Query notes (learned against the live graph):**
- `ImportedSymbol` columns must be valid (`identifier_name`, not `name`) or the API rejects the query with HTTP 400.
- `MergeRequest` queries use default columns; an explicit column allowlist is rejected. Filters use the `{ "op": "eq", "value": ... }` form.
- The response parser (`extractRows` / `flattenNode`) normalizes the graph shape (`{ result: { nodes: [...] } }`), tabular shapes, and alias-prefixed columns (e.g. `imp_file_path` → `file_path`).

Transitive traversal is bounded for cost: it expands up to the first 5 direct dependents to depth 2.

---

## Data Provenance & Fallback

GitPulse **never silently emits demo data**. Every report carries a `data_source` and `is_real_data` flag. Resolution order:

1. **Orbit REST** → `data_source: "orbit-remote"` — the real knowledge graph (preferred).
2. **Static import analysis** → `data_source: "static-analysis"` — `static-analysis.js` parses real `import` statements on disk to build a true reverse-dependency graph. Used when Orbit is unreachable; dependents are real, owner/MR/pipeline data may be limited.
3. **Labeled mock** → `data_source: "mock-fallback"` — last resort, rendered with a loud `⚠️ MOCK DATA` banner; `safe_to_merge` is forced to `false`.

Provenance is surfaced in both the CLI banner and the JSON output, so a fallback report can never be mistaken for a real Orbit trace.

---

## Risk Scoring

The deterministic formula lives in `report.js` (`calculateRiskScore`):

```
score = (direct_dependents      × 5)
      + (transitive_dependents  × 2)
      + (teams_affected         × 10)
      + (open_mr_overlaps       × 15)
      + (pipeline_count         × 5)

LOW:    score < 30
MEDIUM: score 30–60
HIGH:   score > 60   (score is capped at 100)
```

The rendered report exposes a single canonical `risk_line` (e.g. `Risk: HIGH (score: 100/100)`); consumers must quote it verbatim and never recompute the score. Only known teams count toward `teams_affected`.

---

## Guardrails

Enforced deterministically (not left to the model):

- **Minimum depth 2** — always reports direct + transitive dependents, never depth=1 only.
- **No silent drops** — every discovered file gets an ownership entry; files with no history are flagged `ownership_basis: "unknown"`.
- **Honest ownership** — ownership is labeled `mr-authorship`, `inferred-from-path`, or `unknown`; never presented as CODEOWNERS unless a CODEOWNERS source is used.
- **3+ teams → HIGH** — escalates regardless of the numeric score.
- **Open MR overlap → never safe** — `safe_to_merge` is never `true` when overlapping open MRs exist.
- **HIGH risk → never safe** — `safe_to_merge` is `false` whenever risk is HIGH.
- **Mock/unknown data → never safe** — `safe_to_merge` is never `true` unless data is real (`orbit-remote` or `static-analysis`).

---

## Report Schema

`buildReport` returns a `BlastRadiusReport` object:

```json
{
  "target": { "file": "orbit.js", "symbol": null },
  "risk": "HIGH",
  "risk_score": 100,
  "risk_line": "Risk: HIGH (score: 100/100)",
  "summary": "3 dependents across 1 team. 3 open MRs touch related code.",
  "dependents": {
    "direct": [{ "file": "agent.js", "team": "...", "owner": "@...", "depth": 1 }],
    "transitive": [{ "file": "cli.js", "depth": 2, "via": "agent.js" }]
  },
  "teams_affected": [{ "name": "...", "files_count": 3, "slack": "#..." }],
  "open_mrs": [{ "id": 4, "title": "...", "author": "@...", "url": "...", "overlap": ["..."] }],
  "pipelines_at_risk": ["pipeline #... (ref)"],
  "suggested_reviewers": ["@altamish6589"],
  "safe_to_merge": false,
  "score_breakdown": {
    "direct_dependents": 2,
    "transitive_dependents": 1,
    "teams_affected": 1,
    "open_mr_overlaps": 3,
    "pipelines_at_risk": 10
  },
  "data_source": "orbit-remote",
  "is_real_data": true
}
```

Use `--format json` to emit this object directly for CI consumption; the default text format is produced by `formatReportForCLI`.

---

## Running in CI

The `.gitlab-ci.yml` `analyze` job runs a real blast-radius analysis on every MR pipeline:

```yaml
analyze:
  stage: test
  image: node:20-alpine
  script:
    - npm ci
    - node cli.js --file orbit.js --project-id ${GITLAB_PROJECT_ID:-$CI_PROJECT_ID}
  allow_failure: true
```

It needs no `ANTHROPIC_API_KEY` (deterministic mode). With a `GITLAB_TOKEN` CI/CD variable it queries the real Orbit graph (`data_source: "orbit-remote"`); otherwise it falls back to real static analysis. Other jobs: `validate` (CLI loads), `unit-test` (`npm test`), `test-mock` (module imports).

---

## Project Structure

```
gitpulse/
├── AGENTS.md                       ← Agent behavior spec (Duo Agent Platform)
├── README.md                       ← This file
├── package.json
├── .env.example
├── .gitlab-ci.yml                   ← validate / unit-test / test-mock / analyze
├── cli.js                          ← CLI entry point + arg parsing
├── agent.js                        ← Claude loop (optional) + deterministic mode
├── orbit.js                        ← Orbit dependency traversal + ownership
├── orbit-client.js                 ← Orbit REST client (+ glab fallback)
├── static-analysis.js              ← real import-graph fallback (no Orbit)
├── gitlab.js                       ← Open MR + pipeline queries via Orbit
├── report.js                       ← Risk scoring + report generation
├── skills/
│   └── blast-radius/
│       └── SKILL.md                ← Duo Agent Platform skill definition
└── tests/
    ├── report.test.js              ← Scoring engine + guardrail tests
    └── orbit-parse.test.js         ← Orbit response-parsing tests
```

---

## Testing

Tests use Node's built-in test runner (no external test framework):

```bash
npm test          # runs: node --test
```

Coverage includes:

- **`tests/report.test.js`** — the scoring formula, the score cap at 100, MEDIUM/HIGH band boundaries, the `team-unknown` exclusion, the 3+ teams → HIGH guardrail, the open-MR-overlap → not-safe guardrail, ownership enrichment, and reviewer suggestion.
- **`tests/orbit-parse.test.js`** — normalization of Orbit's graph, tabular, and alias-prefixed response shapes, and clean module imports.

---

## Publishing to AI Catalog

This project is structured as a GitLab Duo Agent Platform skill. To publish:

1. Push to GitLab.com as a public project.
2. Navigate to **Automate > Agents** in the project sidebar.
3. Create a new agent using the `skills/blast-radius/SKILL.md` skill.
4. Set visibility to **Public**.
5. The agent appears in **Explore > AI Catalog** for others to enable.

---

## How GitPulse Compares

The "what depends on this code" problem is crowded, but existing tools each solve only one slice. GitPulse's edge is **multi-signal fusion on a knowledge graph with deterministic scoring**.

### Existing solutions

- **Static dependency/import analyzers** (Madge, dependency-cruiser, NX/Turborepo affected-graph, Bazel query): trace import graphs accurately but are *code-only* — no knowledge of teams, open MRs, pipelines, or risk.
- **Code-ownership tools** (CODEOWNERS, git blame): map files to owners but do no dependency traversal and no impact scoring.
- **CI impact analysis** (NX affected, Turborepo, Bazel): compute affected build/test targets for caching, not human-facing risk reports.
- **Codebase Q&A AI** (Sourcegraph Cody, generic Duo Chat, Cursor): answer "who imports X" conversationally but lack a deterministic risk score and don't correlate live MRs or pipelines.

### What makes GitPulse stand out (USP)

> **The only pre-merge gate that fuses dependency graph, ownership, in-flight MRs, and pipeline risk into one deterministic, reproducible safety verdict on GitLab's knowledge graph.**

1. **Multi-signal fusion** — dependents + owners + overlapping open MRs + pipelines combined into one `risk_score` and a binary `safe_to_merge` flag.
2. **Live, cross-team context** — open-MR correlation catches in-flight collisions that pure static analyzers cannot see.
3. **Deterministic, auditable scoring** — the formula and guardrails live in `report.js`, not the LLM, so the same input always yields the same score.
4. **Honest provenance** — every report declares whether it used the real Orbit graph, real static analysis, or mock data; it never passes one off as another.
5. **Runs anywhere** — no API key required (deterministic mode), no `glab` binary required (REST transport).

### Capability comparison

| Capability | Static analyzers | CODEOWNERS / blame | AI code Q&A | **GitPulse** |
|---|---|---|---|---|
| Dependency traversal (transitive) | ✅ | ❌ | ⚠️ approximate | ✅ depth ≥ 2 |
| Owner mapping | ❌ | ✅ | ❌ | ✅ from MR history |
| In-flight open-MR collision | ❌ | ❌ | ❌ | ✅ |
| Pipeline risk | ⚠️ build targets only | ❌ | ❌ | ✅ |
| Deterministic risk score | ✅ static only | ❌ | ❌ | ✅ formula + guardrails |
| Reviewer suggestions | ❌ | ⚠️ owners only | ❌ | ✅ |
| `safe_to_merge` verdict | ❌ | ❌ | ❌ | ✅ |
| Honest data provenance | ❌ | ❌ | ❌ | ✅ |

---

## Hackathon

Built for **GitLab Transcend Hackathon 2026** — Showcase Track.

**Developer pain point**: developers change shared code without knowing what depends on it, causing unexpected breakage in production.

**How GitPulse fixes it**: by querying GitLab Orbit's knowledge graph, GitPulse traces every dependent file, maps ownership, finds conflicting open MRs, identifies at-risk pipelines, and produces an actionable, risk-scored blast radius report in seconds.

**What changes for the developer**: instead of manually searching imports for 30+ minutes (and still missing things), developers get a complete, provenance-tagged impact analysis before every merge.

---

## License

MIT
