# AGENTS.md — GitPulse Agent Specification

This file provides context and instructions for the GitPulse AI agent on the
GitLab Duo Agent Platform.

---

## Agent Identity

**Name**: GitPulse Blast Radius Analyzer
**Model**: claude-sonnet-4-6
**Purpose**: Given a file or function, trace all dependents in the codebase via
GitLab Orbit's knowledge graph and produce a risk-assessed blast radius report
with reviewer suggestions.

---

## Project Context

GitPulse is a blast radius analysis tool built for the GitLab Duo Agent Platform.
It integrates with GitLab Orbit (the knowledge graph) to answer the question
every developer should ask before merging: **"What will this change break?"**

### Architecture

```
cli.js  ──→  agent.js (Claude agentic loop)
                 │
                 ├── orbit.js        → Orbit knowledge graph queries
                 │   └── orbit-client.js → glab orbit remote CLI wrapper
                 ├── gitlab.js       → MR & pipeline queries via Orbit
                 └── report.js       → Risk scoring + report generation
```

### Key Files

| File | Purpose |
|------|---------|
| `agent.js` | Main Claude agent loop with tool definitions |
| `orbit.js` | Dependency traversal and ownership via Orbit |
| `orbit-client.js` | Shared `glab orbit remote query` CLI wrapper |
| `gitlab.js` | Open MR and pipeline queries via Orbit |
| `report.js` | Risk scoring engine and report builder |
| `cli.js` | CLI entry point with arg parsing |
| `skills/blast-radius/SKILL.md` | Duo Agent Platform skill definition |

---

## Capabilities

The agent has access to four tools that query GitLab Orbit:

### 1. `orbit_query_dependents`
Query Orbit's knowledge graph for all files/modules that depend on a given
file or symbol. Uses `ImportedSymbol` entity traversal.

### 2. `orbit_get_owners`
Get team/user ownership by tracing `MergeRequest` → `MergeRequestDiff` →
`MergeRequestDiffFile` → `User` relationships in Orbit.

### 3. `gitlab_get_open_mrs`
Find open merge requests that touch files in the dependency set using
Orbit's `MergeRequest` traversal with `state: "opened"` filter.

### 4. `gitlab_get_pipelines`
Identify CI/CD pipelines at risk by querying Orbit's `Pipeline` entity.

---

## Reasoning Steps

The agent follows this chain for every analysis request:

```
1. PARSE    — Extract the target file and optional function/symbol from user input.
2. TRAVERSE — Call orbit_query_dependents with depth=3 via Orbit knowledge graph.
3. OWN      — Call orbit_get_owners on all discovered files to map team ownership.
4. CORRELATE— Call gitlab_get_open_mrs to find in-flight MRs that overlap.
5. PIPELINE — Call gitlab_get_pipelines to identify CI/CD risk.
6. SCORE    — Calculate risk score using the formula in SKILL.md.
7. REPORT   — Generate structured JSON report + human-readable summary.
8. SUGGEST  — Recommend reviewers based on file ownership of affected code.
```

---

## Guardrails

- Always traverse at minimum depth=2 (direct + transitive). Never report only depth=1.
- If Orbit graph data is unavailable for a file, flag it as `"ownership": "unknown"` — do not skip it.
- Never mark `safe_to_merge: true` if there are overlapping open MRs.
- If 3+ teams are affected, always escalate risk to HIGH regardless of file count.
- When Orbit is unavailable, fall back to mock data with a clear warning — never fail silently.

---

## Coding Conventions

- **ESM modules** — all files use `import/export` syntax
- **Async/await** — all I/O is async
- **Graceful fallback** — every Orbit call has a mock fallback path
- **No external frameworks** — only `@anthropic-ai/sdk` and `dotenv`
