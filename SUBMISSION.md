# GitPulse — Transcend Hackathon Submission Package

This file is the operational checklist + narrative for the **Showcase Track**
submission. It maps GitPulse to every judging criterion and lists the exact
remaining human steps (record video, publish to AI Catalog, submit on Devpost).

---

## 1. Submission checklist (hard requirements)

| # | Requirement | Status | Owner action |
|---|-------------|--------|--------------|
| 0 | **Real Orbit graph proof** | ✅ CI `orbit-proof` job emits `orbit-report.json` with `data_source: "orbit-remote"`; verified in pipeline log (`[Orbit] ✓ Real graph data returned`, `Data source: orbit-remote (real graph: yes)`) | — |
| 1 | Working agent/skill on the Duo Agent Platform that meaningfully uses Orbit | ✅ Built (`AGENTS.md`, `skills/blast-radius/SKILL.md`); real Orbit REST traversal (`POST /api/v4/orbit/query`) confirmed in CI | — |
| 2 | Performs a specific action/workflow (not just chat) | ✅ Blast-radius workflow: traverse → own → correlate → score → report | — |
| 3 | Public, MIT-licensed GitLab project | ✅ `LICENSE` (MIT), public project | — |
| 4 | At least one agent/flow published to the **AI Catalog** | ⚠️ **PENDING** | Publish (see §3) |
| 5 | Demo video ≤ 3 min, public on YouTube/Vimeo | ⚠️ **PENDING** | Record (see §4) |
| 6 | Devpost submission with problem/solution/how-built/next | ⚠️ **PENDING** | Submit (see §5) |

---

## 2. The story (Devpost narrative — copy/paste ready)

### The developer pain point
A developer changes `calculateTax()` in `utils/tax.js`. Three days later a
microservice nobody knew depended on it breaks in production. The post-mortem
always ends the same way: *"We didn't know that was connected."* Manual
dependency hunting takes 30+ minutes and still misses transitive paths,
in-flight MRs, and cross-team ownership.

### How GitPulse fixes it
GitPulse is a blast-radius analyzer on the GitLab Duo Agent Platform. Given a
file or function, it queries **GitLab Orbit's knowledge graph** to:
1. Traverse dependents (`ImportedSymbol` graph) — direct + transitive.
2. Map ownership (`MergeRequest → MergeRequestDiff → MergeRequestDiffFile → User`).
3. Correlate in-flight open MRs touching the same files (`HAS_DIFF → HAS_FILE`).
4. Flag at-risk CI/CD pipelines (`Pipeline` entity, `merge_request_event`).
5. Score risk deterministically and suggest reviewers from real ownership.

### What changes for the developer
Instead of 30 minutes of grep-and-pray, they get a complete, risk-scored
impact report in seconds — before they merge. Teams get notified, reviewers
get suggested, unsafe merges get flagged. The knowledge graph turns "what will
this break?" from tribal knowledge into a query.

### How we built it
- **Orbit** via `glab orbit remote query` (typed CLI) for all graph traversal.
- **Claude** (Anthropic SDK) drives which files/symbols to investigate.
- **Deterministic engine** (`report.js`) computes the risk score and guardrails
  so results are reproducible, not model-improvised.
- **Node.js / ESM**, graceful mock fallback when Orbit is unavailable, CI with
  unit + smoke tests.

### What's next
- Post the report directly as an MR comment via a CI gate.
- Slack/Teams notification to affected team channels.
- Depth-aware scoring weighting and historical incident correlation.

---

## 2b. Proof of real Orbit data & enforcing behavior

GitPulse no longer just prints a report — it proves provenance and enforces gates:

- **Proof artifact**: the CI `orbit-proof` job runs
  `node cli.js --file orbit.js --require-orbit --format json` and uploads
  `orbit-report.json`. `--require-orbit` makes the job fail unless
  `data_source === "orbit-remote"`, so a passing job is hard proof the real
  Orbit knowledge graph answered. Verified run on MR !11:
  `Data source: orbit-remote (real graph: yes)` — `Risk: HIGH (score: 77/100)`.
- **Enforcing risk gate**: the `risk-gate` job runs `--fail-on HIGH` with no
  `allow_failure`, so a HIGH-risk change blocks the pipeline. Target file is
  configurable via the `GITPULSE_TARGET` CI/CD variable.
- **MR comment**: the `mr-report` job posts the report as an idempotent MR note
  (`--comment`), updating in place via a hidden marker. Needs a masked
  `api`-scoped `GITLAB_TOKEN` CI/CD variable.

## 2c. Contribute Track

- All qualifying MRs must carry the **`orbit::hackathon`** label and be merged
  before **June 24, 2026, 2:00 pm ET** (max 5 MRs per person).
- The `label-guard` CI job fails any MR pipeline missing the label, and
  `.gitlab/merge_request_templates/Hackathon.md` applies it automatically via
  a `/label` quick action.

## 3. Publish to the AI Catalog (required)

1. In the GitLab project, open **Automate → Agents** (or **AI → Agents**).
2. Create a new agent backed by the `blast-radius` skill
   (`skills/blast-radius/SKILL.md`).
3. Set the agent **visibility to Public**.
4. Confirm it appears under **Search or go to → Explore → AI Catalog**.
5. Copy the public AI Catalog URL into the Devpost submission and into the
   README badge slot below.

> The repository is already structured for this: `AGENTS.md` defines the agent
> contract and `skills/blast-radius/SKILL.md` defines the skill.

---

## 4. Demo video script (≤ 3 minutes)

Record against a **real Orbit-indexed project** so live graph data is visible
(not mock). Suggested beats:

- **0:00–0:20 — Hook.** "A one-line change to a shared util took down
  production. Here's how GitPulse stops that."
- **0:20–0:45 — Setup.** Show `glab auth status` + the target file in a real
  indexed repo.
- **0:45–1:45 — Run it live.**
  `node cli.js --file <real/file.js> --function <fn> --project-id <id>`
  Narrate the tool calls as they print: dependents, owners, open MRs,
  pipelines.
- **1:45–2:30 — The report.** Walk the risk score, affected teams, suggested
  reviewers, and the `safe_to_merge: NO` guardrail.
- **2:30–2:55 — Catalog.** Show the published agent in the AI Catalog and run
  it from Duo.
- **2:55–3:00 — Close.** "Before you push, know what breaks."

Upload to YouTube/Vimeo, set **Public**, no copyrighted music.

---

## 5. Devpost submission

- Track: **Showcase**.
- Paste the §2 narrative.
- Links: public GitLab project, published AI Catalog agent (§3), demo video (§4).
- Submit before **June 24, 2026, 2:00 pm ET**.

---

## 6. Judging-criteria mapping

| Criterion | How GitPulse scores |
|-----------|---------------------|
| **Technological Implementation** | Real Orbit graph traversal via typed `glab orbit remote query`; deterministic, unit-tested scoring engine; green CI (validate + unit-test + mock smoke). |
| **Design and Usability** | Single-command CLI, `--json` for CI, emoji-structured report, `.env.example`, graceful fallback with a clear warning. |
| **Potential Impact** | Prevents cross-team production breakage — a universal SDLC pain point; replicable for any Orbit-indexed repo. |
| **Quality of the idea** | Turns "blast radius" from tribal knowledge into a graph query; combines dependency + ownership + in-flight MR + pipeline context in one report. |
