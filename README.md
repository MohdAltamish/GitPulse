# GitPulse — Blast Radius Analyzer

> *"Before you push, know what breaks."*

GitPulse is an AI-powered agent built on the **GitLab Duo Agent Platform** that uses **GitLab Orbit's knowledge graph** to trace every dependent of a file or function you're about to change. It produces an instant **Blast Radius Report** — complete with risk score, affected teams, open MRs, and suggested reviewers.

Built for the **GitLab Transcend Hackathon 2025** (Showcase Track).

---

## The Problem

A developer changes `calculateTax()` in `utils/tax.js`. Three days later, production breaks in a microservice nobody knew depended on it. The post-mortem always ends the same way: *"We didn't know that was connected."*

Manual dependency hunting takes 30+ minutes and still misses things. GitPulse makes it **10 seconds and complete** by querying Orbit's knowledge graph.

---

## How It Works

GitPulse uses **GitLab Orbit** (the knowledge graph) via `glab orbit remote query` to:

1. **Traverse dependencies** — Query the `ImportedSymbol` entity to find every file that imports the target
2. **Map ownership** — Trace `MergeRequest → MergeRequestDiff → MergeRequestDiffFile → User` to find who owns each file
3. **Find conflicting MRs** — Discover open merge requests touching the same files
4. **Assess pipeline risk** — Identify CI/CD pipelines that would be affected
5. **Score and report** — Calculate a risk score and produce a structured report with suggested reviewers

```
User Input (file/function)
        │
        ▼
  GitPulse Agent (Claude via Anthropic API)
        │
        ├── GitLab Orbit Knowledge Graph (via glab orbit remote)
        │     ├── ImportedSymbol traversal (dependency graph)
        │     ├── MergeRequest → User traversal (ownership)
        │     └── Pipeline queries (CI/CD risk)
        │
        └── Blast Radius Report (JSON + formatted CLI output)
```

---

## Demo

```bash
# Analyze blast radius of a function
node cli.js --file utils/tax.js --function calculateTax --project-id 12345

# Output
📊 Blast Radius Report — utils/tax.js::calculateTax()
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 Risk: HIGH  (9 dependents across 3 teams)

📁 Direct Dependents (files that import this)
  ├── src/checkout/CartService.js       (Team: team-checkout)
  ├── src/invoicing/InvoiceGen.js       (Team: team-finance)
  └── src/reports/TaxSummary.js         (Team: team-reports)

🔗 Transitive Dependents (files that depend on those)
  ├── src/checkout/CheckoutFlow.jsx
  ├── src/checkout/OrderConfirmation.jsx
  └── ... 4 more

👥 Teams to Notify
  ├── #team-checkout    (3 files affected)
  ├── #team-finance     (3 files affected)
  └── #team-reports     (2 files affected)

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

## Quick Start

```bash
# Clone the repo
git clone https://gitlab.com/altamish6589/gitpulse.git
cd gitpulse

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Fill in ANTHROPIC_API_KEY (required)

# Ensure glab is authenticated for Orbit queries
glab auth status

# Run analysis
node cli.js --file utils/tax.js --function calculateTax --project-id 12345

# JSON output for CI integration
node cli.js --file utils/tax.js --format json --project-id 12345
```

---

## GitLab Orbit Integration

GitPulse queries Orbit via `glab orbit remote query` with these patterns:

| Query | Orbit Entity | Relationship | Purpose |
|-------|-------------|-------------|---------|
| Find dependents | `ImportedSymbol` | `import_path` filter | Trace who imports the target file |
| Find owners | `MergeRequest` → `User` | `HAS_DIFF`, `HAS_FILE`, `AUTHORED` | Map files to their last committers |
| Open MRs | `MergeRequest` → `MergeRequestDiffFile` | `HAS_DIFF`, `HAS_FILE` | Find MRs touching the same files |
| Pipelines | `Pipeline` | `source` filter | Identify affected CI/CD pipelines |

If Orbit is unavailable (no `glab`, auth issues, feature flag), GitPulse falls back to mock data with a clear warning.

---

## Project Structure

```
gitpulse/
├── AGENTS.md                  ← Agent behavior spec (Duo Agent Platform)
├── LICENSE                    ← MIT License
├── README.md                  ← This file
├── .gitlab-ci.yml             ← CI/CD pipeline
├── skills/
│   └── blast-radius/
│       └── SKILL.md           ← Duo Agent Platform skill definition
├── agent.js                   ← Main Claude agent loop
├── orbit.js                   ← Orbit knowledge graph queries
├── orbit-client.js            ← glab orbit remote CLI wrapper
├── gitlab.js                  ← MR & pipeline queries via Orbit
├── report.js                  ← Risk scoring + report generation
├── cli.js                     ← CLI entry point
├── package.json
├── .env.example
└── .gitignore
```

---

## Stack

- **Agent**: Claude Sonnet (via Anthropic API) — reasoning + report generation
- **Graph**: GitLab Orbit — dependency knowledge graph (via `glab orbit remote`)
- **Platform**: GitLab Duo Agent Platform — AGENTS.md + SKILL.md conventions
- **CLI**: Node.js with ESM modules
- **CI**: GitLab CI/CD

---

## Publishing to AI Catalog

This project is structured as a GitLab Duo Agent Platform skill. To publish:

1. Push to GitLab.com as a public project
2. Navigate to **AI > Agents** in the project sidebar
3. Create a new agent with the blast-radius skill
4. Set visibility to **Public**
5. The agent appears in **Explore > AI Catalog** for others to enable

---

## Risk Scoring Formula

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

**Guardrails**: 3+ teams → always HIGH. Open MR overlap → never `safe_to_merge`.

---

## Hackathon

Built for **GitLab Transcend Hackathon 2025** — Showcase Track.

**Developer Pain Point**: Developers change shared code without knowing what depends on it, causing unexpected breakage in production.

**How GitPulse Fixes It**: By querying GitLab Orbit's knowledge graph, GitPulse traces every dependent file, maps team ownership, finds conflicting MRs, and produces an actionable blast radius report — all in seconds.

**What Changes for the Developer**: Instead of manually searching imports for 30+ minutes (and still missing things), developers get a complete, risk-scored impact analysis before every merge. Teams get notified, reviewers get suggested, and unsafe merges get flagged.
