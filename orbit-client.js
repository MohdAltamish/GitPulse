/**
 * Orbit Client — Shared wrapper for `glab orbit remote query`
 *
 * Executes Orbit Knowledge Graph queries via the glab CLI.
 * Falls back to null (caller handles fallback) if glab/orbit is unavailable.
 */

import { execFile as execFileCb } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

/** Whether we've already warned about orbit being unavailable */
let orbitWarned = false;

/**
 * Execute a query against GitLab Orbit Remote via `glab orbit remote query`.
 *
 * @param {object} queryBody - The query object (will be wrapped in { query: ... })
 * @param {object} [options]
 * @param {boolean} [options.showQuery=false] - Log the query body for audit
 * @returns {Promise<object|null>} Parsed JSON response, or null if orbit is unavailable
 */
export async function queryOrbit(queryBody, options = {}) {
  const fullBody = { query: queryBody };
  const tmpPath = join(tmpdir(), `gitpulse-q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);

  if (options.showQuery) {
    console.log(`    [Orbit Query] ${JSON.stringify(fullBody, null, 2)}`);
  }

  try {
    await writeFile(tmpPath, JSON.stringify(fullBody), "utf-8");

    const { stdout, stderr } = await execFile(
      "glab",
      ["orbit", "remote", "query", "--format", "raw", tmpPath],
      { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }
    );

    if (stderr && stderr.includes("error")) {
      console.warn(`    [Orbit] Warning: ${stderr.trim()}`);
    }

    const result = JSON.parse(stdout);
    return result;
  } catch (error) {
    if (!orbitWarned) {
      orbitWarned = true;
      const reason = error.code === "ENOENT"
        ? "glab CLI not found"
        : error.message.includes("feature flag")
          ? "Orbit feature flag not enabled"
          : error.message.includes("auth")
            ? "glab not authenticated"
            : error.message;
      console.warn(`    ⚠️  [Orbit] Unavailable (${reason}). Using mock data as fallback.`);
    }
    return null;
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

/**
 * Check if glab orbit is available and functional.
 * @returns {Promise<boolean>}
 */
export async function isOrbitAvailable() {
  try {
    await execFile("glab", ["orbit", "remote", "status"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}
