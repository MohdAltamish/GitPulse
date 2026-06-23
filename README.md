# GitPulse — Blast Radius Analyzer

> *"Before you push, know what breaks."*

GitPulse is an AI-powered agent built on the **GitLab Duo Agent Platform** that uses **GitLab Orbit's knowledge graph** to trace every dependent of a file or function you're about to change. It produces an instant **Blast Radius Report** complete with a risk score, affected teams, overlapping open MRs, at-risk pipelines, and suggested reviewers.

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
- [Risk Scoring](#risk-scoring)
- [Guardrails](#guardrails)
- [Report Schema](#report-schema)
- [Project Structure](#project-structure)
- [Testing](#testing)
- [Mock Fallback Mode](#mock-fallback-mode)
- [Publishing to AI Catalog](#publishing-to-ai-catalog)
- [Hackathon](#hackathon)
- [License](#license)

---

## The Problem

A developer changes `calculateTax()` in `utils/tax.js`. Three days later, production breaks in a microservice nobody knew depended on it. The post-mortem always ends the same way: *"We didn't know that was connected."*

Manual dependency hunting takes 30+ minutes and still misses things. GitPulse makes it **seconds and complete** by querying Orbit's knowledge graph instead of grepping imports by hand.

---

## How It Works

GitPulse pairs a **Claude agent** (which decides *what* to investigate) with a **deterministic scoring engine** (which guarantees the SKILL.md formula and AGENTS.md guardrails always execute the same way). The model drives the tool calls; `report.js` computes the final risk score and renders the report.

The analysis chain for every request:

1. **Parse** the target file and optional function/symbol.
2. **Traverse** dependents via Orbit's `ImportedSymbol` entity (direct + transitive, depth >= 2).
3. **Own** every discovered file by tracing `MergeRequest → MergeRequestDiff → MergeRequestDiffFile → User`.
4. **Correlate** in-flight changes by finding open MRs that overlap the affected files.
5. **Pipeline** assess CI/CD risk by querying Orbit's `Pipeline` entity.
6. **Score** the change with the deterministic formula in `report.js`.
7. **Report** a structured JSON object plus an emoji-rich CLI summary.
8. **Suggest** reviewers based on the ownership of affected code.

---

## Architecture

```
cli.js  ──→  agent.js (Claude agentic loop, model: claude-sonnet-4-6)
                 │
                 │  drives four tools, then hands results to report.js
                 │
                 ├── orbit.js        → dependency traversal + ownership
                 │     └── orbit-client.js → glab orbit remote query wrapper
                 ├── gitlab.js       → open MRs + pipelines via Orbit
                 └── report.js       → deterministic scoring + report builder
```

- **`cli.js`** parses arguments, validates env vars, invokes the agent, and prints text or JSON output.
- **`agent.js`** runs the Claude loop with four tool definitions, accumulates tool results, then calls `report.js` deterministically so scoring never depends on what the model "decides" the risk is.
- **`orbit.js`** implements `orbitQueryDependents` and `orbitGetOwners`, each with a mock fallback.
- **`gitlab.js`** implements `gitlabGetOpenMRs` and `gitlabGetPipelines`, each with a mock fallback.
- **`orbit-client.js`** is the shared `glab orbit remote query --format raw` wrapper; returns `null` so callers fall back to mock data when Orbit is unavailable.
- **`report.js`** holds `calculateRiskScore`, `buildReport`, and `formatReportForCLI`.

```
User Input (file/function)
        │
        ▼
  GitPulse Agent (Claude via Anthropic API)
        │
        ├── GitLab Orbit Knowledge Graph (via glab orbit remote)
        │     ├── ImportedSymbol traversal (dependency graph)
        │     ├── MergeRequest → User traversal (ownership)
        │     ├── MergeRequest → MergeRequestDiffFile (open-MR overlap)
        │     └── Pipeline queries (CI/CD risk)
        │
        └── report.js (deterministic scoring) ──→ Blast Radius Report (JSON + CLI)
```

---

## Quick Start

```bash
# 1. Clone the repo
git clone https://gitlab.com/gitlab-ai-hackathon/transcend/35602696.git gitpulse
cd gitpulse

# 2. Install dependencies (only @anthropic-ai/sdk and dotenv)
npm install

# 3. Set up environment
cp .env.example .env
# Fill in ANTHROPIC_API_KEY (required). Add GITLAB_TOKEN / GITLAB_PROJECT_ID for real data.

# 4. (Optional) Authenticate glab so Orbit queries work; without it, GitPulse uses mock data.
glab auth status

# 5. Run an analysis
node cli.js --file utils/tax.js --function calculateTax --project-id 12345
```

Requires **Node.js 18+** (uses the built-in `node --test` runner and ESM modules).

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

A bare positional argument is treated as the file path, so `node cli.js utils/tax.js -p 12345` also works.

### Examples

```bash
# Analyze a specific function
node cli.js --file utils/tax.js --function calculateTax --project-id 12345

# Analyze an entire file
node cli.js --file src/auth/AuthService.js --project-id 12345

# JSON output for CI integration
node cli.js --file utils/tax.js --format json --project-id 12345
```

### Example Output

```
📊 Blast Radius Report — utils/tax.js::calculateTax()
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 Risk: HIGH  (score: 84/100)
   9 dependents across 3 teams. 2 open MRs touch related code.

📁 Direct Dependents (files that import this)
   ├── src/checkout/CartService.js            (Team: team-checkout)
   ├── src/invoicing/InvoiceGen.js            (Team: team-finance)
   └── src/reports/TaxSummary.js              (Team: team-reports)

🔗 Transitive Dependents (files that depend on those)
   ├── src/checkout/CheckoutFlow.jsx (depth: 2, via: src/checkout/CartService.js)
   └── ... more

👥 Teams to Notify
   ├── #team-checkout          (3 files affected)
   ├── #team-finance           (3 files affected)
   └── #team-reports           (2 files affected)

🔀 Open MRs Touching Related Code
   ├── !234 — "Add EU tax rates" by @alice
   └── !289 — "Refactor invoice generation" by @bob

⚙️  Pipelines at Risk
   └── checkout-service-ci, invoice-gen-ci, reports-ci

✅ Suggested Reviewers
   └── @alice, @bob, @carol (owners of affected files)

📋 Safe to merge without notifying these teams? 🚫 NO
```

---

## Configuration

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | yes | Claude API key for the agent loop |
| `GITLAB_TOKEN` | for real data | GitLab PAT with `read_api`, `read_repository` scopes |
| `GITLAB_PROJECT_ID` | optional | Default project ID (overridable with `--project-id`) |
| `ORBIT_API_URL` | optional | Orbit API base URL (defaults to `https://gitlab.com/-/orbit/api/v1`) |

Without `ANTHROPIC_API_KEY`, `cli.js` exits early with a setup hint. Without `glab`/Orbit access, GitPulse runs in [mock fallback mode](#mock-fallback-mode).

---

## GitLab Orbit Integration

GitPulse queries Orbit via `glab orbit remote query --format raw` (see `orbit-client.js`). Each query writes a temp JSON file, runs the CLI, parses the graph-shaped response, and cleans up.

| Query | Orbit Entity | Relationship | Purpose |
|-------|-------------|-------------|---------|
| Find dependents | `ImportedSymbol` | `import_path` `contains` filter | Trace who imports the target file |
| Find owners | `MergeRequest` → `User` | `HAS_DIFF`, `HAS_FILE`, `AUTHORED` | Map files to their recent authors |
| Open MRs | `MergeRequest` → `MergeRequestDiffFile` | `HAS_DIFF`, `HAS_FILE` | Find open MRs touching the same files |
| Pipelines | `Pipeline` | `source` filter, `created_at` order | Identify affected CI/CD pipelines |

The response parser (`extractRows` / `flattenNode`) normalizes Orbit's graph shape (`{ result: { nodes: [...] } }`), tabular shapes (`{ rows: [...] }`), and alias-prefixed columns (e.g. `imp_file_path` → `file_path`) into a flat property map.

Transitive traversal is bounded for cost control: it expands up to the first 5 direct dependents to depth 2, and owner/MR lookups batch the first 5–10 files to respect Orbit's iteration budget.

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

Only known teams count toward `teams_affected`; files resolving to `team-unknown` are excluded from that factor.

---

## Guardrails

Enforced deterministically (not left to the model):

- **Minimum depth 2** — always reports direct + transitive dependents, never depth=1 only.
- **No silent drops** — if the model misses ownership for any discovered file, `agent.js` resolves the missing owners before scoring; files with no MR history are flagged `"ownership": "unknown"`.
- **3+ teams → HIGH** — escalates to HIGH regardless of the numeric score.
- **Open MR overlap → never safe** — `safe_to_merge` is never `true` when overlapping open MRs exist.
- **HIGH risk → never safe** — `safe_to_merge` is `false` whenever risk is HIGH.
- **Graceful fallback** — every Orbit call has a mock path; GitPulse never fails silently.

---

## Report Schema

`buildReport` returns a `BlastRadiusReport` object:

```json
{
  "target": { "file": "utils/tax.js", "symbol": "calculateTax" },
  "risk": "HIGH",
  "risk_score": 84,
  "summary": "9 dependents across 3 teams. 2 open MRs touch related code.",
  "dependents": {
    "direct": [{ "file": "...", "team": "...", "owner": "@...", "depth": 1 }],
    "transitive": [{ "file": "...", "team": "...", "owner": "@...", "depth": 2, "via": "..." }]
  },
  "teams_affected": [{ "name": "team-checkout", "files_count": 3, "slack": "#team-checkout" }],
  "open_mrs": [{ "id": 234, "title": "...", "author": "@alice", "url": "...", "overlap": ["..."] }],
  "pipelines_at_risk": ["checkout-service-ci"],
  "suggested_reviewers": ["@alice", "@bob", "@carol"],
  "safe_to_merge": false,
  "score_breakdown": {
    "direct_dependents": 3,
    "transitive_dependents": 6,
    "teams_affected": 3,
    "open_mr_overlaps": 2,
    "pipelines_at_risk": 3
  }
}
```

Use `--format json` to emit this object directly for CI consumption; the default text format is produced by `formatReportForCLI`.

---

## Project Structure

```
gitpulse/
├── AGENTS.md                       ← Agent behavior spec (Duo Agent Platform)
├── README.md                       ← This file
├── package.json
├── .env.example
├── cli.js                          ← CLI entry point + arg parsing
├── agent.js                        ← Claude agent loop + tool definitions
├── orbit.js                        ← Orbit dependency traversal + ownership
├── orbit-client.js                 ← glab orbit remote query wrapper
├── gitlab.js                       ← Open MR + pipeline queries via Orbit
├── report.js                       ← Risk scoring + report generation
├── skills/
│   └── blast-radius/
│       └── SKILL.md                ← Duo Agent Platform skill definition
├── tests/
│   ├── report.test.js              ← Scoring engine + guardrail tests
│   └── orbit-parse.test.js         ← Orbit response-parsing tests
└── .agents/
    └── skills/orbit/               ← Orbit skill references + helper scripts
```

---

## Testing

Tests use Node's built-in test runner (no external test framework):

```bash
npm test          # runs: node --test
```

Coverage includes:

- **`tests/report.test.js`** — the SKILL.md scoring formula, the score cap at 100, MEDIUM/HIGH band boundaries, the `team-unknown` exclusion, the 3+ teams → HIGH guardrail, the open-MR-overlap → not-safe guardrail, ownership enrichment, and reviewer suggestion.
- **`tests/orbit-parse.test.js`** — normalization of Orbit's graph, tabular, and alias-prefixed response shapes.

---

## Mock Fallback Mode

If `glab` is missing, unauthenticated, or Orbit's feature flag is disabled, `orbit-client.js` returns `null` and each integration falls back to realistic mock data with a one-time warning:

```
⚠️  [Orbit] Unavailable (glab CLI not found). Using mock data as fallback.
```

This keeps demos and local development fully functional offline. Mock data covers a sample checkout/invoicing/reports dependency graph, owners, open MRs, and pipelines so you can exercise the full report end-to-end without Orbit access.

---

## Publishing to AI Catalog

This project is structured as a GitLab Duo Agent Platform skill. To publish:

1. Push to GitLab.com as a public project.
2. Navigate to **AI > Agents** in the project sidebar.
3. Create a new agent using the `skills/blast-radius/SKILL.md` skill.
4. Set visibility to **Public**.
5. The agent appears in **Explore > AI Catalog** for others to enable.

---

## How GitPulse Compares

The "what depends on this code" problem is crowded, but existing tools each solve only one slice. GitPulse's edge is **multi-signal fusion on a knowledge graph with deterministic scoring**.

### Existing solutions

- **Static dependency/import analyzers** (Madge, dependency-cruiser, NX/Turborepo affected-graph, Bazel query): trace import graphs accurately but are *code-only* — no knowledge of teams, open MRs, pipelines, or risk. They tell you files, not consequences.
- **Code-ownership tools** (CODEOWNERS, git blame): map files to owners but do no dependency traversal and no impact scoring.
- **CI impact analysis** (NX affected, Turborepo, Bazel): compute affected build/test targets for caching, not human-facing risk reports or reviewer suggestions.
- **Codebase Q&A AI** (Sourcegraph Cody, generic Duo Chat, Cursor): can answer "who imports X" conversationally but lack a deterministic, reproducible risk score and don't correlate live MRs or pipelines.
- **Test impact analysis** (Launchable, Sealights): predict which tests to run — a narrower goal than cross-team merge safety.

### What makes GitPulse stand out (USP)

> **The only pre-merge gate that fuses dependency graph, team ownership, in-flight MRs, and pipeline risk into one deterministic, reproducible safety verdict on GitLab's knowledge graph.**

1. **Multi-signal fusion** — dependents + teams + overlapping open MRs + pipelines combined into one `risk_score` and a binary `safe_to_merge` flag.
2. **Live, cross-team context** — open-MR correlation (`HAS_DIFF → HAS_FILE`, `state: opened`) catches in-flight collisions that pure static analyzers structurally cannot see.
3. **Deterministic, auditable scoring** — the risk formula and guardrails live in `report.js`, not in the LLM, so the same input always yields the same score (exactly what a merge gate needs).
4. **Enforced safety guardrails** — 3+ teams forces HIGH; any overlapping open MR forces `safe_to_merge: false`; minimum depth 2 is mandatory; unknown ownership is flagged, never silently dropped.
5. **Native Orbit knowledge-graph leverage** — uses GitLab's own graph rather than re-implementing parsing.
6. **Actionable output** — suggested reviewers from real ownership, teams to notify, and CI-consumable JSON (`--format json`).

### Capability comparison

| Capability | Static analyzers (Madge, dep-cruiser, NX) | CODEOWNERS / blame | AI code Q&A (Cody, Cursor) | **GitPulse** |
|---|---|---|---|---|
| Dependency traversal (transitive) | ✅ | ❌ | ⚠️ approximate | ✅ depth ≥ 2 |
| Team/owner mapping | ❌ | ✅ | ❌ | ✅ from MR history |
| In-flight open-MR collision | ❌ | ❌ | ❌ | ✅ |
| Pipeline risk | ⚠️ build targets only | ❌ | ❌ | ✅ |
| Deterministic risk score | ✅ static only | ❌ | ❌ | ✅ formula + guardrails |
| Reviewer suggestions | ❌ | ⚠️ owners only | ❌ | ✅ |
| `safe_to_merge` verdict | ❌ | ❌ | ❌ | ✅ |
| CI-gate JSON output | ⚠️ | ❌ | ❌ | ✅ |

---

## Hackathon

Built for **GitLab Transcend Hackathon 2026** — Showcase Track.

**Developer pain point**: developers change shared code without knowing what depends on it, causing unexpected breakage in production.

**How GitPulse fixes it**: by querying GitLab Orbit's knowledge graph, GitPulse traces every dependent file, maps team ownership, finds conflicting open MRs, identifies at-risk pipelines, and produces an actionable, risk-scored blast radius report in seconds.

**What changes for the developer**: instead of manually searching imports for 30+ minutes (and still missing things), developers get a complete impact analysis before every merge. Teams get notified, reviewers get suggested, and unsafe merges get flagged.

---

## License

MIT
