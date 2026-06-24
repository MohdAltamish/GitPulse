/**
 * GitPulse Diff Analyzer
 *
 * Heuristic, dependency-free detection of likely breaking changes in a unified
 * git diff. Detection is intentionally conservative about confidence:
 *
 *   - high   : removed exports — importers reliably break.
 *   - medium : removed/renamed function declarations — callers may break.
 *   - low    : signature / return-shape hints — regex cannot parse JS, so
 *              these are surfaced as hints, never as assertions.
 *
 * This module never participates in risk scoring; it only annotates the report
 * so the deterministic score in report.js stays the single source of truth.
 */

/**
 * @typedef {Object} BreakingChange
 * @property {string} type        Machine-readable category.
 * @property {string} detail      Human-readable explanation.
 * @property {("high"|"medium"|"low")} confidence  How reliable the signal is.
 */

/** Strip the leading +/- and whitespace from a diff line body. */
function body(line) {
  return line.replace(/^[+-]/, "").trim();
}

/**
 * Collect names captured by a regex across an array of diff lines.
 * @param {string[]} lines
 * @param {RegExp} re  Must expose the name in capture group 1.
 * @returns {Set<string>}
 */
function names(lines, re) {
  const out = new Set();
  for (const line of lines) {
    const m = body(line).match(re);
    if (m && m[1]) out.add(m[1]);
  }
  return out;
}

// Matches `export const foo`, `export function foo`, `export class Foo`,
// `export default function foo`, and `export async function foo`.
const EXPORT_RE =
  /^export\s+(?:default\s+)?(?:async\s+)?(?:const|let|var|function\*?|class)\s+(\w+)/;

// Matches a function/arrow declaration name in either form:
//   function foo(            const foo = (        const foo = async (
const FUNC_DECL_RE =
  /(?:function\*?\s+(\w+)\s*\()|(?:(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\()/;

/** Like {@link names} but tolerant of FUNC_DECL_RE's two capture slots. */
function funcNames(lines) {
  const out = new Set();
  for (const line of lines) {
    const m = body(line).match(FUNC_DECL_RE);
    const name = m && (m[1] || m[2]);
    if (name) out.add(name);
  }
  return out;
}

/**
 * Analyze a unified diff for likely breaking changes.
 *
 * @param {string} diff  Unified diff text (may be empty/undefined).
 * @returns {BreakingChange[]}
 */
export function analyzeBreakingChanges(diff) {
  /** @type {BreakingChange[]} */
  const breaking = [];
  if (!diff || typeof diff !== "string") return breaking;

  // Only real content changes — ignore hunk headers (+++/---) and context.
  const lines = diff.split(/\r?\n/);
  const removed = lines.filter(
    (l) => l.startsWith("-") && !l.startsWith("--")
  );
  const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("++"));

  // 1. Removed exports — highest precision signal.
  const removedExports = names(removed, EXPORT_RE);
  const addedExports = names(added, EXPORT_RE);
  const droppedExports = [...removedExports].filter(
    (name) => !addedExports.has(name)
  );
  if (droppedExports.length > 0) {
    breaking.push({
      type: "export_removed",
      detail: `${droppedExports.length} export(s) removed (${droppedExports.join(
        ", "
      )}) — importers will fail to resolve them.`,
      confidence: "high",
    });
  }

  // 2. Removed / renamed functions — medium precision.
  const removedFns = funcNames(removed);
  const addedFns = funcNames(added);
  const droppedFns = [...removedFns].filter((name) => !addedFns.has(name));
  const newFns = [...addedFns].filter((name) => !removedFns.has(name));
  if (droppedFns.length > 0) {
    // If functions vanished while new ones appeared, a rename is likely.
    const renameLikely = newFns.length > 0;
    breaking.push({
      type: renameLikely ? "function_renamed" : "function_removed",
      detail: renameLikely
        ? `Function(s) removed (${droppedFns.join(
            ", "
          )}) while new one(s) appeared (${newFns.join(
            ", "
          )}) — likely renamed; callers using the old name break.`
        : `Function(s) removed (${droppedFns.join(
            ", "
          )}) — callers will hit runtime/reference errors.`,
      confidence: "medium",
    });
  }

  // 3. Return-shape change hint — low precision (regex can't parse JS).
  const removedReturnsObj = removed.some((l) => /return\s+\{/.test(body(l)));
  const addedReturnsScalar = added.some((l) =>
    /return\s+(['"`]|[A-Za-z_$][\w$]*\s*;?$)/.test(body(l))
  );
  if (removedReturnsObj && addedReturnsScalar) {
    breaking.push({
      type: "return_shape_changed",
      detail:
        "A return value may have changed shape (object → scalar/other). Verify callers that destructure the result.",
      confidence: "low",
    });
  }

  return breaking;
}
