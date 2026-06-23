/**
 * Static Import Analysis — real dependency graph without Orbit.
 *
 * When the Orbit knowledge graph is unavailable, GitPulse should still produce
 * a *correct* dependency graph rather than fictional mock data. This module
 * walks the repository, parses ES-module `import`/`export ... from` statements,
 * resolves the relative specifiers to real files, and builds a reverse
 * dependency map (who imports whom). A BFS from the target file then yields
 * direct (depth 1) and transitive (depth >= 2) dependents.
 *
 * Pure Node.js (fs/path only) — no external parser dependency, matching the
 * project's "no external frameworks" convention.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, relative, dirname, extname } from "node:path";

const SOURCE_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"];
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".agents",
]);

/**
 * Match `import ... from "<spec>"`, `export ... from "<spec>"`, bare
 * `import "<spec>"`, and dynamic `import("<spec>")`. Captures the specifier.
 */
const IMPORT_RE =
  /(?:import\s[^;]*?\sfrom\s*|export\s[^;]*?\sfrom\s*|import\s*|import\s*\(\s*)["']([^"']+)["']/g;

/**
 * Recursively collect all source files under `root`.
 * @param {string} root - Absolute repo root.
 * @returns {Promise<string[]>} Absolute file paths.
 */
async function collectSourceFiles(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".") {
        if (IGNORED_DIRS.has(entry.name)) continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(full);
      } else if (SOURCE_EXTENSIONS.includes(extname(entry.name))) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

/**
 * Extract relative import specifiers from file source.
 * Only relative specifiers (starting with '.') are local dependencies.
 * @param {string} source
 * @returns {string[]}
 */
function extractRelativeImports(source) {
  const specs = [];
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(source)) !== null) {
    const spec = m[1];
    if (spec.startsWith(".")) specs.push(spec);
  }
  return specs;
}

/**
 * Resolve a relative import specifier from `fromFile` to an actual repo file.
 * Tries the literal path, then common extensions, then /index.* variants.
 * @param {string} fromFileAbs - Absolute path of the importing file.
 * @param {string} spec - Relative specifier (e.g. "./gitlab.js", "../report").
 * @param {Set<string>} knownFilesAbs - Set of absolute paths that exist.
 * @returns {string|null} Absolute resolved path, or null if unresolved.
 */
function resolveImport(fromFileAbs, spec, knownFilesAbs) {
  const base = resolve(dirname(fromFileAbs), spec);
  const candidates = [base];
  if (!extname(base)) {
    for (const ext of SOURCE_EXTENSIONS) candidates.push(base + ext);
    for (const ext of SOURCE_EXTENSIONS) candidates.push(join(base, "index" + ext));
  } else if (!knownFilesAbs.has(base)) {
    // Has an extension but might be missing; still try index fallbacks.
    for (const ext of SOURCE_EXTENSIONS) candidates.push(join(base, "index" + ext));
  }
  for (const c of candidates) {
    if (knownFilesAbs.has(c)) return c;
  }
  return null;
}

/**
 * Build the blast-radius dependency graph for `targetFile` using real static
 * import analysis of the repository on disk.
 *
 * @param {string} targetFile - Repo-relative path of the file to analyze.
 * @param {string|null} symbol - Optional symbol (recorded, not yet traced).
 * @param {number} depth - Max traversal depth (default 3).
 * @param {string} [root=process.cwd()] - Repo root to scan.
 * @returns {Promise<object|null>} Graph in the GitPulse shape, or null if the
 *   repo could not be scanned / the target file was not found.
 */
export async function staticAnalyzeDependents(
  targetFile,
  symbol = null,
  depth = 3,
  root = process.cwd()
) {
  const rootAbs = resolve(root);

  let rootStat;
  try {
    rootStat = await stat(rootAbs);
  } catch {
    return null;
  }
  if (!rootStat.isDirectory()) return null;

  const fileList = await collectSourceFiles(rootAbs);
  if (fileList.length === 0) return null;

  const knownFilesAbs = new Set(fileList);
  const targetAbs = resolve(rootAbs, targetFile);

  // Target must exist as a source file to anchor the traversal.
  if (!knownFilesAbs.has(targetAbs)) return null;

  // Build forward edges: importerAbs -> Set(importedAbs).
  // From that, derive reverse edges: importedAbs -> Set(importerAbs).
  const reverse = new Map(); // importedAbs -> Set(importerAbs)
  for (const fileAbs of fileList) {
    let source;
    try {
      source = await readFile(fileAbs, "utf-8");
    } catch {
      continue;
    }
    for (const spec of extractRelativeImports(source)) {
      const resolved = resolveImport(fileAbs, spec, knownFilesAbs);
      if (!resolved || resolved === fileAbs) continue;
      if (!reverse.has(resolved)) reverse.set(resolved, new Set());
      reverse.get(resolved).add(fileAbs);
    }
  }

  const toRel = (abs) => relative(rootAbs, abs).split("\\").join("/");

  // BFS over reverse edges from the target.
  const direct = [];
  const transitive = [];
  const seen = new Set([targetAbs]);
  let frontier = [{ abs: targetAbs, level: 0 }];
  let maxDepthReached = 0;

  while (frontier.length > 0) {
    const next = [];
    for (const { abs, level } of frontier) {
      if (level >= depth) continue;
      const importers = reverse.get(abs);
      if (!importers) continue;
      for (const importerAbs of importers) {
        if (seen.has(importerAbs)) continue;
        seen.add(importerAbs);
        const childLevel = level + 1;
        maxDepthReached = Math.max(maxDepthReached, childLevel);
        const rel = toRel(importerAbs);
        if (childLevel === 1) {
          direct.push({
            file: rel,
            import_type: "static",
            import_path: targetFile,
            depth: 1,
          });
        } else {
          transitive.push({
            file: rel,
            via: toRel(abs),
            depth: childLevel,
          });
        }
        next.push({ abs: importerAbs, level: childLevel });
      }
    }
    frontier = next;
  }

  return {
    target: { file: targetFile, symbol },
    direct,
    transitive,
    metadata: {
      total_dependents: direct.length + transitive.length,
      max_depth_reached: maxDepthReached,
      graph_complete: true,
      source: "static-analysis",
      orbit_version: "none",
      scanned_files: fileList.length,
    },
  };
}
