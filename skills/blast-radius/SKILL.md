---
name: blast-radius
description: >
  Analyze the blast radius of a code change by traversing GitLab Orbit's
  knowledge graph. Given a file or function, find all dependents, map them
  to owning users/teams, check for overlapping open MRs, identify at-risk
  CI/CD pipelines, and produce a risk-scored blast radius report with
  suggested reviewers. Use this skill when a developer asks "what will break
  if I change this file?" or when assessing the impact of a refactor before merge.
version: 1.1.0
license: MIT
metadata:
  audience: developers
  keywords: blast-radius, impact-analysis, orbit, dependency-graph, code-review, safety
  workflow: ai
---

# Blast Radius Analysis Skill

Analyze the impact of code changes using GitLab Orbit's knowledge graph
before they're merged. This skill traces every dependent file, maps
ownership, checks for conflicting open MRs, identifies at-risk pipelines,
and produces a deterministic, risk-scored report.

## When to Use

Use this skill when:
- A developer asks "what will break if I change X?"
- Analyzing the impact of a refactor to a shared module
- Pre-merge review needs to identify affected owners
- A CI/CD gate requires blast-radius approval above a risk threshold
- Onboarding to a new codebase and assessing how interconnected a file is

## Trigger Phrases
- "what breaks if I change X"
- "blast radius of <file>"
- "analyze impact of this file"
- "is it safe to change X"
- "/gitpulse analyze <file>"

## Inputs

| Field        | Type    | Required | Description |
|--------------|---------|----------|-------------|
| `file`       | string  | yes      | Relative path to the file being changed |
| `symbol`     | string  | no       | Specific function/class/export being changed |
| `depth`      | integer | no       | Traversal depth (default: 3, max: 5) |
| `project_id` | string  | yes      | GitLab project ID (or `$CI_PROJECT_ID` in CI) |

## Outputs

Returns a `BlastRadiusReport` object:

```json
{
  "target": { "file": "...", "symbol": "..." },
  "risk": "LOW | MEDIUM | HIGH",
  "risk_score": 0,
  "risk_line": "Risk: HIGH (score: 100/100)",
  "summary": "...",
  "dependents": { "direct": [...], "transitive": [...] },
  "teams_affected": [...],
  "open_mrs": [...],
  "pipelines_at_risk": [...],
  "suggested_reviewers": [...],
  "safe_to_merge": true,
  "score_breakdown": { },
  "data_source": "orbit-remote | static-analysis | mock-fallback | unknown",
  "is_real_data": true
}
```

- `risk_line` is the single canonical, non-overridable score string; consumers
  must quote it verbatim and never recompute the score.
- `data_source` / `is_real_data` disclose provenance so a mock report can never
  be mistaken for a real one.

## How It Works

GitPulse queries the GitLab Orbit knowledge graph over the **REST API**
(`POST /api/v4/orbit/query`). No external binary is required; the call uses
`CI_API_V4_URL` (or `GITLAB_API_URL`) and authenticates with `GITLAB_TOKEN`
(an `api`-scoped token), falling back to `CI_JOB_TOKEN`. The `glab orbit
remote query` CLI is only a secondary transport for local development.

In the Duo Agent Platform, the equivalent native tools are:
- `Orbit: List Commands` — discover available graph commands
- `Orbit: Get Graph Status` — verify the project is indexed before traversal
- `Orbit: Get Graph Schema` — confirm valid entity/column names
- `Orbit: Query Graph` / `Orbit: Invoke Command` — run the traversals below

### 1. Dependency Traversal
Query the `ImportedSymbol` entity to find files that import the target,
scoped to the project. Use only valid columns (`identifier_name`, not `name`)
or the API rejects the query with HTTP 400.

```json
{
  "query": {
    "query_type": "traversal",
    "node": {
      "id": "imp",
      "entity": "ImportedSymbol",
      "filters": {
        "import_path": { "op": "contains", "value": "orbit" },
        "project_id":  { "op": "eq", "value": 83678311 }
      },
      "columns": ["file_path", "import_path", "identifier_name", "import_type"]
    },
    "limit": 100
  }
}
```

Depth 2+ repeats the query for each discovered dependent's basename.

### 2. Ownership Lookup
Resolve owners from the real `AUTHORED` edge (User → MergeRequest), then map
authors to the affected files. Ownership is labeled by `ownership_basis`:
`"mr-authorship"` (from the graph), `"inferred-from-path"` (fallback), or
`"unknown"` (no history). It is never presented as CODEOWNERS data unless a
CODEOWNERS source is actually used.

```json
{
  "query": {
    "query_type": "traversal",
    "nodes": [
      { "id": "u",  "entity": "User" },
      { "id": "mr", "entity": "MergeRequest",
        "filters": { "project_id": { "op": "eq", "value": 83678311 } } }
    ],
    "relationships": [
      { "type": "AUTHORED", "from": "u", "to": "mr" }
    ],
    "limit": 50
  }
}
```

### 3. Open MR Correlation
Find open MRs and their changed files via
`MergeRequest → MergeRequestDiff → MergeRequestDiffFile`
(`HAS_DIFF`, `HAS_FILE`), then match overlap by file basename in-app. Use
default columns (an explicit MergeRequest column allowlist is rejected).

```json
{
  "query": {
    "query_type": "traversal",
    "nodes": [
      { "id": "mr", "entity": "MergeRequest",
        "filters": {
          "state":      { "op": "eq", "value": "opened" },
          "project_id": { "op": "eq", "value": 83678311 }
        } },
      { "id": "diff", "entity": "MergeRequestDiff" },
      { "id": "f",    "entity": "MergeRequestDiffFile" }
    ],
    "relationships": [
      { "type": "HAS_DIFF", "from": "mr",   "to": "diff" },
      { "type": "HAS_FILE", "from": "diff", "to": "f" }
    ],
    "limit": 500
  }
}
```

### 4. Pipeline Risk Assessment
Query recent `Pipeline` entities for the project and report the real
pipeline id/status/ref (no path-based name inference).

```json
{
  "query": {
    "query_type": "traversal",
    "node": {
      "id": "p",
      "entity": "Pipeline",
      "filters": { "source": { "op": "eq", "value": "merge_request_event" } }
    },
    "order_by": { "node": "p", "property": "created_at", "direction": "DESC" },
    "limit": 10
  }
}
```

## Risk Scoring

```
score = (direct_dependents     × 5)
      + (transitive_dependents  × 2)
      + (teams_affected         × 10)
      + (open_mr_overlaps       × 15)
      + (pipeline_count         × 5)

LOW:    score < 30
MEDIUM: score 30–60
HIGH:   score > 60   (capped at 100)
```

The score is computed deterministically by `calculateRiskScore` in
`report.js`. It is the only authoritative score; the model must never invent,
recompute, "normalize", or cap it.

### Guardrails
- Always traverse at minimum depth 2 (direct + transitive).
- If a file has no graph data, label `ownership_basis: "unknown"` — never skip it.
- `safe_to_merge` is never `true` when there are overlapping open MRs.
- `safe_to_merge` is never `true` for mock/unknown `data_source`.
- If 3+ teams are affected, escalate to HIGH regardless of score.

## Data Provenance & Fallback

GitPulse never silently emits demo data. Resolution order:
1. **Orbit REST** → `data_source: "orbit-remote"` (real graph).
2. **Static import analysis** of the repo on disk → `data_source: "static-analysis"`
   (real dependents; owner/MR/pipeline data may be limited). Used when Orbit is
   unreachable.
3. **Labeled mock** → `data_source: "mock-fallback"`, rendered with a loud
   `⚠️ MOCK DATA` banner; `safe_to_merge` forced to `false`.

The agent also runs without `ANTHROPIC_API_KEY`: it executes the four tools
deterministically (no LLM) and produces the same report.

## Example Usage

```bash
# Analyze an entire file in this project
node cli.js --file orbit.js --project-id 83678311

# Analyze a specific function
node cli.js --file utils/tax.js --function calculateTax --project-id 83678311

# JSON output for CI integration
node cli.js --file orbit.js --format json --project-id ${CI_PROJECT_ID}
```

## Integration Points
- **CI job**: the `analyze` job runs the report on every MR pipeline.
- **CI/CD gate**: fail or warn when `risk === "HIGH"`.
- **MR comments** (optional): post the markdown report on the MR.
- **Duo Chat**: invoke via `/gitpulse analyze <file>`.

## Project
- GitLab: https://gitlab.com/gitlab-ai-hackathon/transcend/35602696
- Built for: GitLab Transcend Hackathon 2026
- License: MIT
