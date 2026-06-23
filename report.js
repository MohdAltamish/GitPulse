/**
 * GitPulse Report Engine
 * Calculates risk scores and builds structured blast radius reports
 * following the schema defined in AGENTS.md and SKILL.md.
 */

/**
 * Calculate a risk score based on the blast radius data.
 *
 * Formula (from SKILL.md):
 *   score = (direct_dependents × 5)
 *         + (transitive_dependents × 2)
 *         + (teams_affected × 10)
 *         + (open_mr_overlaps × 15)
 *         + (pipeline_count × 5)
 *
 * Risk levels:
 *   LOW:    score < 30
 *   MEDIUM: score 30–60
 *   HIGH:   score > 60
 *
 * Guardrail (from AGENTS.md):
 *   If 3+ teams are affected, always escalate to HIGH regardless of score.
 *
 * @param {object} graph - Dependency graph from Orbit
 * @param {object[]} owners - Ownership data for affected files
 * @param {object[]} mrs - Open MRs with file overlap
 * @param {object[]} pipelines - CI/CD pipelines at risk
 * @returns {{ score: number, level: string }}
 */
export function calculateRiskScore(graph, owners, mrs, pipelines) {
  const directCount = graph.direct ? graph.direct.length : 0;
  const transitiveCount = graph.transitive ? graph.transitive.length : 0;

  // Count unique teams
  const uniqueTeams = new Set(
    owners.map((o) => o.team).filter((t) => t && t !== "team-unknown")
  );
  const teamsCount = uniqueTeams.size;

  const mrOverlaps = mrs ? mrs.length : 0;
  const pipelineCount = pipelines ? pipelines.length : 0;

  // Apply scoring formula from SKILL.md
  const score =
    directCount * 5 +
    transitiveCount * 2 +
    teamsCount * 10 +
    mrOverlaps * 15 +
    pipelineCount * 5;

  // Determine risk level from the score band (SKILL.md):
  //   LOW: < 30   MEDIUM: 30–60   HIGH: > 60
  let level;
  if (score > 60) {
    level = "HIGH";
  } else if (score >= 30) {
    level = "MEDIUM";
  } else {
    level = "LOW";
  }

  // Guardrail (AGENTS.md): 3+ teams always escalates to HIGH regardless of score.
  if (teamsCount >= 3) {
    level = "HIGH";
  }

  return {
    score: Math.min(score, 100), // Cap at 100
    level,
    breakdown: {
      direct_dependents: directCount,
      transitive_dependents: transitiveCount,
      teams_affected: teamsCount,
      open_mr_overlaps: mrOverlaps,
      pipelines_at_risk: pipelineCount,
    },
  };
}

/**
 * Build the full blast radius report object matching the AGENTS.md output schema.
 *
 * @param {object} params
 * @param {string} params.file - Target file path
 * @param {string|null} params.symbol - Target function/symbol (optional)
 * @param {object} params.graph - Dependency graph from Orbit
 * @param {object[]} params.owners - Ownership data
 * @param {object[]} params.mrs - Open MRs with overlap
 * @param {object[]} params.pipelines - CI/CD pipelines at risk
 * @param {{ score: number, level: string, breakdown: object }} params.score - Risk score result
 * @returns {object} Structured blast radius report
 */
export function buildReport({ file, symbol, graph, owners, mrs, pipelines, score }) {
  // Build ownership lookup map
  const ownerMap = new Map();
  for (const o of owners) {
    ownerMap.set(o.file, o);
  }

  // Enrich direct dependents with ownership info
  const directDeps = (graph.direct || []).map((dep) => {
    const ownership = ownerMap.get(dep.file) || {};
    return {
      file: dep.file,
      team: ownership.team || "unknown",
      owner: ownership.owner || "@unknown",
      import_type: dep.import_type,
      depth: dep.depth || 1,
    };
  });

  // Enrich transitive dependents with ownership info
  const transitiveDeps = (graph.transitive || []).map((dep) => {
    const ownership = ownerMap.get(dep.file) || {};
    return {
      file: dep.file,
      depth: dep.depth,
      team: ownership.team || "unknown",
      owner: ownership.owner || "@unknown",
      via: dep.via,
    };
  });

  // Aggregate teams affected
  const teamAggregation = new Map();
  const allDeps = [...directDeps, ...transitiveDeps];
  for (const dep of allDeps) {
    const team = dep.team;
    if (!teamAggregation.has(team)) {
      teamAggregation.set(team, { name: team, files_count: 0, files: [] });
    }
    const entry = teamAggregation.get(team);
    entry.files_count++;
    entry.files.push(dep.file);
  }

  const teamsAffected = Array.from(teamAggregation.values()).map((t) => ({
    name: t.name,
    files_count: t.files_count,
    slack: `#${t.name}`,
  }));

  // Format open MRs
  const openMRs = (mrs || []).map((mr) => ({
    id: mr.id,
    title: mr.title,
    author: mr.author,
    url: mr.url,
    overlap: mr.overlap || [],
  }));

  // Pipeline names at risk
  const pipelinesAtRisk = (pipelines || []).map((p) => p.name);

  // Collect unique suggested reviewers from ownership data
  const reviewerSet = new Set();
  for (const dep of allDeps) {
    if (dep.owner && dep.owner !== "@unknown") {
      reviewerSet.add(dep.owner);
    }
  }
  const suggestedReviewers = Array.from(reviewerSet);

  // Data provenance: 'orbit-remote' = real graph, anything else = mock fallback.
  const dataSource = (graph.metadata && graph.metadata.source) || "unknown";
  const isRealData = dataSource === "orbit-remote";

  // Safe to merge? (AGENTS.md guardrail: never true if overlapping open MRs).
  // Never certify a merge from mock/unknown data either.
  const safeToMerge =
    isRealData && openMRs.length === 0 && score.level !== "HIGH";

  const totalDependents = directDeps.length + transitiveDeps.length;
  const teamCount = teamsAffected.filter((t) => t.name !== "unknown").length;

  const summary = `${totalDependents} dependents across ${teamCount} team${teamCount !== 1 ? "s" : ""}. ${openMRs.length} open MR${openMRs.length !== 1 ? "s" : ""} touch${openMRs.length === 1 ? "es" : ""} related code.`;

  return {
    target: {
      file,
      symbol: symbol || null,
    },
    risk: score.level,
    risk_score: score.score,
    summary,
    dependents: {
      direct: directDeps,
      transitive: transitiveDeps,
    },
    teams_affected: teamsAffected,
    open_mrs: openMRs,
    pipelines_at_risk: pipelinesAtRisk,
    suggested_reviewers: suggestedReviewers,
    safe_to_merge: safeToMerge,
    score_breakdown: score.breakdown,
    data_source: dataSource,
    is_real_data: isRealData,
  };
}

/**
 * Format a blast radius report as a human-readable CLI string.
 * Matches the emoji-rich output format shown in the README.
 *
 * @param {object} report - Structured blast radius report
 * @returns {string} Formatted CLI output
 */
export function formatReportForCLI(report) {
  const lines = [];
  const { target, risk, risk_score, summary } = report;

  const riskEmoji = { HIGH: "🔴", MEDIUM: "🟡", LOW: "🟢" };
  const targetLabel = target.symbol
    ? `${target.file}::${target.symbol}()`
    : target.file;

  lines.push("");
  lines.push(`📊 Blast Radius Report — ${targetLabel}`);
  lines.push("━".repeat(60));
  if (!report.is_real_data) {
    lines.push(
      `⚠️  MOCK DATA (source: ${report.data_source}). Orbit was unavailable — this report is DEMO data, not a real blast-radius trace. Do not use it for merge decisions.`
    );
    lines.push("━".repeat(60));
  }
  lines.push(
    `${riskEmoji[risk] || "⚪"} Risk: ${risk}  (score: ${risk_score}/100)`
  );
  lines.push(`   ${summary}`);
  lines.push("");

  // Direct dependents
  if (report.dependents.direct.length > 0) {
    lines.push("📁 Direct Dependents (files that import this)");
    const direct = report.dependents.direct;
    direct.forEach((dep, i) => {
      const connector = i === direct.length - 1 ? "└──" : "├──";
      const teamLabel = dep.team !== "unknown" ? `(Team: ${dep.team})` : "(Team: unknown)";
      lines.push(`   ${connector} ${dep.file.padEnd(42)} ${teamLabel}`);
    });
    lines.push("");
  }

  // Transitive dependents
  if (report.dependents.transitive.length > 0) {
    lines.push("🔗 Transitive Dependents (files that depend on those)");
    const transitive = report.dependents.transitive;
    transitive.forEach((dep, i) => {
      const connector = i === transitive.length - 1 ? "└──" : "├──";
      lines.push(`   ${connector} ${dep.file} (depth: ${dep.depth}, via: ${dep.via})`);
    });
    lines.push("");
  }

  // Teams affected
  if (report.teams_affected.length > 0) {
    lines.push("👥 Teams to Notify");
    const teams = report.teams_affected;
    teams.forEach((team, i) => {
      const connector = i === teams.length - 1 ? "└──" : "├──";
      lines.push(
        `   ${connector} ${team.slack.padEnd(25)} (${team.files_count} file${team.files_count !== 1 ? "s" : ""} affected)`
      );
    });
    lines.push("");
  }

  // Open MRs
  if (report.open_mrs.length > 0) {
    lines.push("🔀 Open MRs Touching Related Code");
    const mrs = report.open_mrs;
    mrs.forEach((mr, i) => {
      const connector = i === mrs.length - 1 ? "└──" : "├──";
      lines.push(
        `   ${connector} !${mr.id} — "${mr.title}" by ${mr.author}`
      );
    });
    lines.push("");
  }

  // Pipelines
  if (report.pipelines_at_risk.length > 0) {
    lines.push("⚙️  Pipelines at Risk");
    lines.push(`   └── ${report.pipelines_at_risk.join(", ")}`);
    lines.push("");
  }

  // Reviewers
  if (report.suggested_reviewers.length > 0) {
    lines.push("✅ Suggested Reviewers");
    lines.push(
      `   └── ${report.suggested_reviewers.join(", ")} (owners of affected files)`
    );
    lines.push("");
  }

  // Safe to merge
  const mergeEmoji = report.safe_to_merge ? "✅" : "🚫";
  const mergeText = report.safe_to_merge ? "YES" : "NO";
  lines.push(
    `📋 Safe to merge without notifying these teams? ${mergeEmoji} ${mergeText}`
  );
  lines.push("");

  return lines.join("\n");
}
