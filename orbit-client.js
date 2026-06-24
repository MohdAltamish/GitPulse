/**
 * Orbit Client — Queries the GitLab Orbit Knowledge Graph.
 *
 * Primary transport is the documented REST endpoint:
 *   POST /api/v4/orbit/query   (body: { query, query_type, response_format })
 * This needs no external binary, so it works in plain CI containers as long as
 * a token is available. The `glab orbit remote query` CLI is kept as a
 * secondary fallback for local dev where a token may not be set.
 *
 * Returns null on any failure so callers fall back to static analysis / mock.
 *
 * Docs: https://docs.gitlab.com/api/orbit/
 */

import { execFile as execFileCb } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

/** Whether we've already warned about orbit being unavailable */
let orbitWarned = false;

/** Which transport produced the last successful response: 'rest' | 'cli' | null */
let lastTransport = null;

/** @returns {('rest'|'cli'|null)} transport of the last successful Orbit query */
export function getLastTransport() {
  return lastTransport;
}

/** Resolve the GitLab API v4 base URL (no trailing slash). */
function apiBaseUrl() {
  const raw =
    process.env.CI_API_V4_URL ||
    process.env.GITLAB_API_URL ||
    "https://gitlab.com/api/v4";
  return raw.replace(/\/$/, "");
}

/**
 * Build auth headers for the Orbit API. Prefer a personal/project token
 * (PRIVATE-TOKEN); fall back to the CI job token (JOB-TOKEN). Returns null if
 * neither is available so we can skip HTTP and try the CLI instead.
 * @returns {Record<string,string>|null}
 */
function authHeaders() {
  const privateToken =
    process.env.GITLAB_TOKEN ||
    process.env.ORBIT_TOKEN ||
    process.env.GITLAB_API_TOKEN;
  if (privateToken) return { "PRIVATE-TOKEN": privateToken };
  if (process.env.CI_JOB_TOKEN) return { "JOB-TOKEN": process.env.CI_JOB_TOKEN };
  return null;
}

function warnOnce(reason) {
  if (orbitWarned) return;
  orbitWarned = true;
  console.warn(`    ⚠️  [Orbit] Unavailable (${reason}). Falling back.`);
}

/**
 * Execute a query against the Orbit Knowledge Graph.
 *
 * @param {object} queryBody - The query DSL object (wrapped in { query: ... }).
 * @param {object} [options]
 * @param {boolean} [options.showQuery=false] - Log the query body for audit.
 * @returns {Promise<object|null>} Parsed JSON response, or null if unavailable.
 */
export async function queryOrbit(queryBody, options = {}) {
  if (options.showQuery) {
    console.log(`    [Orbit Query] ${JSON.stringify({ query: queryBody }, null, 2)}`);
  }

  // 1) Preferred: REST API over HTTP (no binary needed).
  const headers = authHeaders();
  if (headers && typeof fetch === "function") {
    try {
      const res = await fetch(`${apiBaseUrl()}/orbit/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
          query: queryBody,
          query_type: "json",
          response_format: "raw",
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (res.ok) {
        lastTransport = "rest";
        return await res.json();
      }
      warnOnce(`HTTP ${res.status} from /orbit/query`);
      // fall through to CLI
    } catch (error) {
      warnOnce(`HTTP error: ${error.message}`);
      // fall through to CLI
    }
  } else if (!headers) {
    warnOnce("no GITLAB_TOKEN/CI_JOB_TOKEN for Orbit REST");
  }

  // 2) Fallback: glab CLI (local dev convenience).
  return queryOrbitViaCli(queryBody);
}

/**
 * Execute a query via `glab orbit remote query` (secondary transport).
 * @param {object} queryBody
 * @returns {Promise<object|null>}
 */
async function queryOrbitViaCli(queryBody) {
  const tmpPath = join(
    tmpdir(),
    `gitpulse-q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
  );
  try {
    await writeFile(tmpPath, JSON.stringify({ query: queryBody }), "utf-8");
    const { stdout } = await execFile(
      "glab",
      ["orbit", "remote", "query", "--format", "raw", tmpPath],
      { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }
    );
    lastTransport = "cli";
    return JSON.parse(stdout);
  } catch (error) {
    const reason = error.code === "ENOENT" ? "glab CLI not found" : error.message;
    warnOnce(reason);
    return null;
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

/**
 * Get the GitLab Orbit knowledge-graph readiness status.
 *
 * Rather than shelling out to `glab orbit remote status` (which isn't present
 * in CI), this issues the same minimal REST probe used by isOrbitAvailable and
 * reports whether the graph actually answered, plus which transport served it.
 * This keeps the status check consistent with how the analyzer really queries.
 *
 * @param {object} [options]
 * @param {string} [options.namespace] - Optional namespace/full path, echoed back
 *   in the result for context (the REST probe is project-scoped by token).
 * @returns {Promise<object>} Structured status (never throws).
 */
export async function getGraphStatus(options = {}) {
  const { namespace } = options;
  const headers = authHeaders();
  if (!headers) {
    return {
      ready: false,
      reason: "no GITLAB_TOKEN/CI_JOB_TOKEN for Orbit REST",
      namespace: namespace || null,
      transport: null,
      source: "mock",
    };
  }

  const probe = {
    query_type: "traversal",
    node: { id: "p", entity: "Pipeline" },
    limit: 1,
  };
  const result = await queryOrbit(probe);
  const ready = result !== null;
  return {
    ready,
    reason: ready ? "graph answered REST probe" : "graph did not answer",
    namespace: namespace || null,
    transport: ready ? lastTransport : null,
    source: ready ? "orbit-remote" : "mock",
  };
}

/**
 * Check if Orbit is reachable (REST token present, or glab status succeeds).
 * @returns {Promise<boolean>}
 */
export async function isOrbitAvailable() {
  // Issue a real, minimal query so we confirm the graph actually answers,
  // rather than merely asserting a token is present.
  const probe = {
    query_type: "traversal",
    node: { id: "p", entity: "Pipeline" },
    limit: 1,
  };
  const result = await queryOrbit(probe);
  return result !== null;
}
