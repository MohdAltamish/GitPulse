/**
 * Shared GitLab REST helpers.
 *
 * Centralizes the API base URL resolution and auth-header selection used by
 * both the Orbit client and the MR-comment integration so the logic lives in
 * exactly one place.
 */

/** Resolve the GitLab API v4 base URL (no trailing slash). */
export function apiBaseUrl() {
  const raw =
    process.env.CI_API_V4_URL ||
    process.env.GITLAB_API_URL ||
    "https://gitlab.com/api/v4";
  return raw.replace(/\/$/, "");
}

/**
 * Build auth headers for the GitLab API. Prefer a personal/project token
 * (PRIVATE-TOKEN); fall back to the CI job token (JOB-TOKEN). Returns null if
 * neither is available.
 * @returns {Record<string,string>|null}
 */
export function authHeaders() {
  const privateToken =
    process.env.GITLAB_TOKEN ||
    process.env.ORBIT_TOKEN ||
    process.env.GITLAB_API_TOKEN;
  if (privateToken) return { "PRIVATE-TOKEN": privateToken };
  if (process.env.CI_JOB_TOKEN) return { "JOB-TOKEN": process.env.CI_JOB_TOKEN };
  return null;
}
