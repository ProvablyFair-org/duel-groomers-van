/**
 * Field-level diffs between a verification run and the committed artifacts it evaluated.
 *
 * tests/verify.ts uses this to decide whether a re-run of the Groomer's Van audit reproduces the
 * committed evidence, and writes the result to outputs/run/diff.json.
 *
 * Two questions are deliberately kept apart. The SHA-256 dataset guard asserts the identity of
 * the captured input — those bytes are the record, and byte equality is the right bar for them.
 * What this module answers is whether a RECOMPUTATION is the same result, which byte equality
 * cannot decide: the last bits of a derived floating-point statistic are a property of the
 * machine that computed them. Demanding byte identity of derived statistics makes "reproduce it
 * yourself" a claim no reader can satisfy; demanding nothing lets a genuinely different result
 * pass as noise.
 */

export type Leaf = string | number | boolean | null;

/** Flatten a JSON value to `dotted.path` → leaf. Arrays index as `path[0]`. */
export function flattenLeaves(value: unknown, prefix = '', out: Map<string, Leaf> = new Map()): Map<string, Leaf> {
  if (value === null || typeof value !== 'object') {
    out.set(prefix, value as Leaf);
    return out;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) out.set(prefix, '<empty array>');
    value.forEach((v, i) => flattenLeaves(v, `${prefix}[${i}]`, out));
    return out;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 0) out.set(prefix, '<empty object>');
  for (const k of keys) flattenLeaves((value as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k, out);
  return out;
}

/** The value as `JSON.stringify` would serialise it — `undefined` keys gone, dates as strings. */
const asWritten = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null));

export interface FieldDiff {
  path: string;
  committed: Leaf | '<absent>';
  thisRun: Leaf | '<absent>';
  /** Numeric pairs only: the gap between the two values, and the gap relative to the larger. */
  absDiff?: number;
  relDiff?: number;
  /**
   * Numeric pairs only. `true` means the two values are the same result computed on different
   * hardware; `false` means they are different results. Non-numeric leaves and absences are
   * never within tolerance.
   */
  withinTolerance?: boolean;
}

/**
 * The reproduction tolerance.
 *
 * A pinned artifact asserts the identity of the committed EVIDENCE — its bytes and its SHA-256
 * are the record, and the hash guard in tests/verify.ts re-asserts them. What this bound governs
 * is a different question: whether a RECOMPUTATION on another machine is the same result. It is
 * not the same question, because the last bits of a derived floating-point statistic are
 * environment-dependent. Demanding byte identity of derived statistics would make "reproduce it
 * yourself" a claim no reader could ever satisfy, and demanding nothing would let a genuinely
 * different result pass as noise.
 *
 * The bound is 1e-14 absolute + 1e-12 relative — far below the precision of any figure this
 * audit publishes, and far above cross-runtime ULP drift.
 */
export const DIFF_ATOL = 1e-14;
export const DIFF_RTOL = 1e-12;

/**
 * Whether two numbers are the same result. Two DISTINCT integers never are: counts, populations,
 * step numbers and bet totals must match exactly, and this is the line that says so. Only an
 * integer PAIR is held to exact equality — an integer against a float is the cross-runtime case
 * (`0` on one machine, `5.55e-16` on another) and gets the tolerance, which is still tighter
 * than any distinct pair of integers could satisfy.
 */
export function numbersAgree(a: number, b: number, atol = DIFF_ATOL, rtol = DIFF_RTOL): boolean {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (Number.isInteger(a) && Number.isInteger(b)) return false;
  return Math.abs(a - b) <= atol + rtol * Math.max(Math.abs(a), Math.abs(b));
}

/**
 * Every leaf on which `committed` and `thisRun` disagree, by path. `ignore` drops paths whose
 * dotted name matches exactly — used for the run timestamp, which differs by construction on
 * every run and would otherwise be the only entry in every diff.
 *
 * Numeric disagreements inside the tolerance are still REPORTED — the diff is a record of what
 * this run computed, and silently dropping them would hide drift that is creeping toward the
 * bound. They are marked `withinTolerance`, and it is `beyondTolerance()` below, not the length
 * of this array, that decides whether the run agrees with the committed evidence.
 */
export function fieldDiff(
  committed: unknown,
  thisRun: unknown,
  ignore: readonly string[] = [],
  tol: { atol?: number; rtol?: number } = {},
): FieldDiff[] {
  const atol = tol.atol ?? DIFF_ATOL;
  const rtol = tol.rtol ?? DIFF_RTOL;
  const a = flattenLeaves(committed);
  // Compare against what WOULD BE WRITTEN, not against the in-memory object. `JSON.stringify`
  // drops keys whose value is `undefined`, so an optional field left unset is absent from the
  // committed file but present-and-undefined in the live object — reported as a disagreement
  // between a file and itself. Round-tripping the fresh side removes that whole class.
  const b = flattenLeaves(asWritten(thisRun));
  const skip = new Set(ignore);
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  const out: FieldDiff[] = [];
  for (const p of paths) {
    if (skip.has(p)) continue;
    const inA = a.has(p), inB = b.has(p);
    const va = inA ? a.get(p)! : '<absent>';
    const vb = inB ? b.get(p)! : '<absent>';
    if (Object.is(va, vb)) continue;
    if (typeof va === 'number' && typeof vb === 'number') {
      const absDiff = Math.abs(va - vb);
      const scale = Math.max(Math.abs(va), Math.abs(vb));
      out.push({
        path: p, committed: va, thisRun: vb, absDiff,
        relDiff: scale === 0 ? 0 : absDiff / scale,
        withinTolerance: numbersAgree(va, vb, atol, rtol),
      });
      continue;
    }
    out.push({ path: p, committed: va, thisRun: vb, withinTolerance: false });
  }
  return out;
}

/** The subset that is a real disagreement rather than cross-runtime float drift. */
export const beyondTolerance = (diffs: readonly FieldDiff[]): FieldDiff[] =>
  diffs.filter(d => !d.withinTolerance);

/** The largest gap seen on any numeric path, for the run record. `null` when there was none. */
export function maxima(diffs: readonly FieldDiff[]): { path: string; absDiff: number; relDiff: number } | null {
  let best: { path: string; absDiff: number; relDiff: number } | null = null;
  for (const d of diffs) {
    if (typeof d.absDiff !== 'number') continue;
    if (best === null || d.absDiff > best.absDiff) best = { path: d.path, absDiff: d.absDiff, relDiff: d.relDiff ?? 0 };
  }
  return best;
}
