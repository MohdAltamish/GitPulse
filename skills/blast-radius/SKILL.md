---
name: blast-radius
description: >
  Analyze the blast radius of a code change by traversing GitLab Orbit's
  knowledge graph. Given a file or function, find all dependents, map them
  to owning teams, check for overlapping open MRs, identify at-risk CI/CD
  pipelines, and produce a risk-scored blast radius report with suggested
  reviewers. Use this skill when a developer asks "what will break if I
  change this file?" or when assessing the impact of a refactor before merge.
version: 1.0.0
license: MIT
metadata:
  audience: developers
  keywords: blast-radius, impact-analysis, orbit, dependency-graph, code-review, safety
  workflow: ai
---

# Blast Radius Analysis Skill

Analyze the impact of code changes using GitLab Orbit's knowledge graph
before they're merged. This skill traces every dependent file, maps team
ownership, checks for conflicting open MRs, and produces a complete risk
report.

## When to Use

Use this skill when:
- A developer asks "what will break if I change X?"
- Analyzing the impact of a refactor to a shared utility
- Pre-merge review needs to identify affected teams
- CI/CD gate requires blast radius approval above a risk threshold
- Onboarding to a new codebase and assessing how interconnected a file is

## Inputs

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | string | yes | Relative path to the file being changed |
| `symbol` | string | no | Specific function/class/export being changed |
| `depth` | integer | no | Traversal depth (default: 3, max: 5) |
| `project_id` | string | yes | GitLab project ID |

## Outputs

Returns a `BlastRadiusReport` object:

```json
{
  "target": { "file": "...", "symbol": "..." },
  "risk": "LOW | MEDIUM | HIGH",
  "risk_score": 0-100,
  "dependents": { "direct": [...], "transitive": [...] },
  "teams_affected": [...],
  "open_mrs": [...],
  "pipelines_at_risk": [...],
  "suggested_reviewers": [...],
  "safe_to_merge": true | false
}
```

## How It Works

The skill uses GitLab Orbit's knowledge graph via `glab orbit remote query` to:

### 1. Dependency Traversal
Query the `ImportedSymbol` entity to find all files that import the target:

```bash
# Find files that import the target module
glab orbit remote query /tmp/dependents.json
```

Query body:
```json
{
  "query": {
    "query_type": "traversal",
    "node": {
      "id": "imp",
      "entity": "ImportedSymbol",
      "filters": {
        "import_path": { "op": "contains", "value": "tax" }
      },
      "columns": ["file_path", "import_path", "name"]
    },
    "limit": 100
  }
}
```

### 2. Ownership Lookup
Query `MergeRequest` → `MergeRequestDiff` → `MergeRequestDiffFile` traversal
to find authors who have recently modified each affected file:

```json
{
  "query": {
    "query_type": "traversal",
    "nodes": [
      { "id": "mr", "entity": "MergeRequest",
        "columns": ["iid", "title", "state"],
        "filters": { "state": { "op": "in", "value": ["merged", "opened"] } } },
      { "id": "diff", "entity": "MergeRequestDiff" },
      { "id": "f", "entity": "MergeRequestDiffFile",
        "filters": { "old_path": { "op": "ends_with", "value": "CartService.js" } } },
      { "id": "author", "entity": "User", "columns": ["username", "name"] }
    ],
    "relationships": [
      { "type": "HAS_DIFF", "from": "mr", "to": "diff" },
      { "type": "HAS_FILE", "from": "diff", "to": "f" },
      { "type": "AUTHORED", "from": "author", "to": "mr" }
    ],
    "limit": 5
  }
}
```

### 3. Open MR Correlation
Find in-flight MRs that overlap with affected files using the same
`HAS_DIFF` → `HAS_FILE` traversal pattern with `state: "opened"` filter.

### 4. Pipeline Risk Assessment
Query `Pipeline` entities to identify CI/CD pipelines that would be
affected by changes to the dependent files.

## Risk Scoring

```
score = (direct_dependents × 5)
      + (transitive_dependents × 2)
      + (teams_affected × 10)
      + (open_mr_overlaps × 15)
      + (pipeline_count × 5)

LOW:    score < 30
MEDIUM: score 30–60
HIGH:   score > 60
```

### Guardrails
- Always traverse at minimum depth=2 (direct + transitive)
- If Orbit data is unavailable for a file, flag as `"ownership": "unknown"` — never skip
- Never mark `safe_to_merge: true` if there are overlapping open MRs
- If 3+ teams are affected, always escalate to HIGH regardless of score

## Error Handling

- If `glab orbit` is not available, falls back to mock data with a clear warning
- If Orbit returns no dependents, reports as "no known dependents — possibly leaf node"
- If CODEOWNERS is missing, marks owner as `unknown` and flags in report
- Partial results are always reported (never suppressed)

## Example Usage

```bash
# Analyze a specific function
node cli.js --file utils/tax.js --function calculateTax --project-id 12345

# Analyze an entire file
node cli.js --file src/auth/AuthService.js --project-id 12345

# JSON output for CI integration
node cli.js --file utils/tax.js --format json --project-id 12345
```

## Integration Points

- **GitLab MR Comments**: Post report as a comment on any MR modifying a high-risk file
- **CI/CD Gate**: Fail pipeline if `risk === 'HIGH'` and no reviewer approval
- **Slack Notification**: Ping affected team channels when blast radius is detected
- **Duo Chat**: Invoke via `/gitpulse analyze <file>`
