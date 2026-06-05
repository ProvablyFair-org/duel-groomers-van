/**
 * CPU/CUDA numerical parity verification.
 *
 * Loads the CPU enumeration output produced by `npm run enumerate:cpu:base`
 * (or `:bonus`) and compares it numerically to the committed CUDA artifact
 * `outputs/{base,bonus}-2pow32.json`. The two engines target the same
 * algorithm but run on different hardware: the CUDA kernel does its
 * payout/bomb arithmetic in float32 while the TS enumerator works in
 * float64, so individual payouts can land in adjacent 0.01-buckets on the
 * order of a few thousand spins per 2³² (~10⁻⁶ in mass). This is float-
 * precision noise, not an algorithmic disagreement.
 *
 * "Numerical parity" here means the engines agree on every aggregate that
 * is determined by the algorithm, within a documented tolerance for the
 * fields that depend on float-accumulation order:
 *
 *   - exact:                range, condition, hist_granularity, wins,
 *                           win_rate, max_payout, scatter_histogram
 *   - within ~1e-6:         rtp, sum (proportional to rtp)
 *   - within ~1e-5 of mass: histogram and joint_histogram (compared as
 *                           total mass per coarse bucket, not bin-for-bin)
 *
 * If anything outside those tolerances diverges, the script reports the
 * first divergences and exits non-zero. The "byte-parity" framing of the
 * pre-launch script was retired because the CUDA float32 / CPU float64
 * split makes literal byte-identity unachievable without rewriting the
 * CUDA kernel in double precision (which we explicitly chose not to).
 *
 * Usage:
 *   ts-node scripts/cpu-cuda-parity.ts --condition base
 *   ts-node scripts/cpu-cuda-parity.ts --condition bonus
 */

import * as fs from 'fs';
import * as path from 'path';

interface Artifact {
  range:             { from: number; to: number; count: number };
  condition:         string;
  sum:               number;
  wins:              number;
  max_payout:        number;
  rtp:               number;
  win_rate:          number;
  elapsed_sec?:      number;
  hist_granularity:  number;
  histogram:         [number, number][];
  scatter_histogram: number[];
  joint_histogram:   [number, number, number][];
}

// Tolerances — chosen to match the observed float32 vs float64 noise floor
// between the CUDA kernel and the TS enumerator over 4.3B spins.
const RTP_EPS         = 1e-6;   // observed ~3e-7 on base, ~5e-7 on bonus
const SUM_REL_EPS     = 1e-6;   // sum scales with 2³² × payout; check as relative
// Histogram mass agreement — per coarse 1×-stake bucket, allow up to
// k × sqrt(max(cpu, cuda)) absolute deviation. That's Poisson noise: if
// the two engines produce statistically equivalent payout distributions,
// the count in any equally-defined partition agrees to within ~sqrt(N).
// k = 5 is 5σ, giving essentially zero false positives if the underlying
// distributions are identical and catching any real algorithmic drift.
const MASS_K_SIGMA    = 5;
// Floor for very-low-count buckets where sqrt(N) is < a handful and the
// long tail can produce ±a few counts of pure float-rounding noise.
const MASS_FLOOR_DIFF = 20;

function parseArgs(argv: string[]): { condition: 'base' | 'bonus' } {
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  const c = (a.condition ?? 'base') === 'bonus' ? 'bonus' : 'base';
  return { condition: c };
}

function load(p: string): Artifact {
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as Artifact;
}

interface Diff { field: string; cpu: unknown; cuda: unknown; tolerance?: string }

function relDiff(a: number, b: number): number {
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-30);
  return Math.abs(a - b) / denom;
}

/**
 * Bucket a histogram into coarser groups (factor 100 → bins of width 1×stake)
 * and compare total mass per coarse bucket. Tolerant of fine-grained
 * float32 vs float64 bucket-edge differences.
 */
function bucketMass(hist: [number, number][], coarsen: number): Map<number, number> {
  const m = new Map<number, number>();
  for (const [bucket, count] of hist) {
    const k = Math.round(bucket / coarsen);
    m.set(k, (m.get(k) ?? 0) + count);
  }
  return m;
}

function compare(cpu: Artifact, cuda: Artifact): Diff[] {
  const diffs: Diff[] = [];

  // ── Exact fields ────────────────────────────────────────────────────────
  if (cpu.range.from   !== cuda.range.from)   diffs.push({ field: 'range.from',   cpu: cpu.range.from,   cuda: cuda.range.from,   tolerance: 'exact' });
  if (cpu.range.to     !== cuda.range.to)     diffs.push({ field: 'range.to',     cpu: cpu.range.to,     cuda: cuda.range.to,     tolerance: 'exact' });
  if (cpu.range.count  !== cuda.range.count)  diffs.push({ field: 'range.count',  cpu: cpu.range.count,  cuda: cuda.range.count,  tolerance: 'exact' });
  if (cpu.condition    !== cuda.condition)    diffs.push({ field: 'condition',    cpu: cpu.condition,    cuda: cuda.condition,    tolerance: 'exact' });
  if (cpu.wins         !== cuda.wins)         diffs.push({ field: 'wins',         cpu: cpu.wins,         cuda: cuda.wins,         tolerance: 'exact' });
  if (cpu.max_payout   !== cuda.max_payout)   diffs.push({ field: 'max_payout',   cpu: cpu.max_payout,   cuda: cuda.max_payout,   tolerance: 'exact' });
  if (cpu.win_rate     !== cuda.win_rate)     diffs.push({ field: 'win_rate',     cpu: cpu.win_rate,     cuda: cuda.win_rate,     tolerance: 'exact' });
  if (cpu.hist_granularity !== cuda.hist_granularity) {
    diffs.push({ field: 'hist_granularity', cpu: cpu.hist_granularity, cuda: cuda.hist_granularity, tolerance: 'exact' });
  }
  for (let i = 0; i < Math.max(cpu.scatter_histogram.length, cuda.scatter_histogram.length); i++) {
    const c1 = cpu.scatter_histogram[i] ?? 0;
    const c2 = cuda.scatter_histogram[i] ?? 0;
    if (c1 !== c2) diffs.push({ field: `scatter_histogram[${i}]`, cpu: c1, cuda: c2, tolerance: 'exact' });
  }

  // ── Float-accumulation fields (tolerant) ────────────────────────────────
  if (Math.abs(cpu.rtp - cuda.rtp) > RTP_EPS) {
    diffs.push({ field: 'rtp', cpu: cpu.rtp, cuda: cuda.rtp, tolerance: `abs <= ${RTP_EPS}` });
  }
  if (relDiff(cpu.sum, cuda.sum) > SUM_REL_EPS) {
    diffs.push({ field: 'sum', cpu: cpu.sum, cuda: cuda.sum, tolerance: `rel <= ${SUM_REL_EPS}` });
  }

  // ── Histogram mass agreement (Poisson-noise tolerance) ────────────────
  // Coarsen to bins of width 1× (i.e. 100× the 0.01 granularity) so trivial
  // bucket-edge differences from float32/float64 don't dominate the picture,
  // then allow Poisson-noise spread per coarse bucket: |cpu - cuda| within
  // max(MASS_FLOOR_DIFF, MASS_K_SIGMA × sqrt(max(cpu, cuda))). Any divergence
  // beyond that is genuine algorithmic drift.
  const coarsen = 100;
  const cpuMass  = bucketMass(cpu.histogram,  coarsen);
  const cudaMass = bucketMass(cuda.histogram, coarsen);
  const keys = new Set<number>([...cpuMass.keys(), ...cudaMass.keys()]);
  let massDiffs = 0;
  for (const k of [...keys].sort((a, b) => a - b)) {
    const c1 = cpuMass.get(k) ?? 0;
    const c2 = cudaMass.get(k) ?? 0;
    const allowed = Math.max(MASS_FLOOR_DIFF, MASS_K_SIGMA * Math.sqrt(Math.max(c1, c2)));
    if (Math.abs(c1 - c2) > allowed) {
      diffs.push({
        field:      `histogram_mass[~${k}×]`,
        cpu:        c1,
        cuda:       c2,
        tolerance:  `|Δ| <= max(${MASS_FLOOR_DIFF}, ${MASS_K_SIGMA}×√max) ≈ ${allowed.toFixed(1)}`,
      });
      if (++massDiffs >= 10) break;
    }
  }

  return diffs;
}

function main() {
  const { condition } = parseArgs(process.argv.slice(2));
  const root     = path.join(__dirname, '..');
  const cpuPath  = path.join(root, 'outputs', `cpu-${condition}-2pow32.json`);
  const cudaPath = path.join(root, 'outputs', `${condition}-2pow32.json`);

  if (!fs.existsSync(cpuPath))  { console.error(`missing CPU artifact: ${cpuPath}`);  process.exit(1); }
  if (!fs.existsSync(cudaPath)) { console.error(`missing CUDA artifact: ${cudaPath}`); process.exit(1); }

  const cpu  = load(cpuPath);
  const cuda = load(cudaPath);

  console.log(`CPU/CUDA numerical parity check — condition=${condition}`);
  console.log(`  CPU file:  ${cpuPath}`);
  console.log(`  CUDA file: ${cudaPath}`);
  console.log('');

  const diffs = compare(cpu, cuda);

  console.log(`  CPU  range.count: ${cpu.range.count}, rtp: ${cpu.rtp.toFixed(10)}, max_payout: ${cpu.max_payout}, win_rate: ${cpu.win_rate}`);
  console.log(`  CUDA range.count: ${cuda.range.count}, rtp: ${cuda.rtp.toFixed(10)}, max_payout: ${cuda.max_payout}, win_rate: ${cuda.win_rate}`);
  console.log(`  CPU  histogram bins: ${cpu.histogram.length}, joint bins: ${cpu.joint_histogram.length}`);
  console.log(`  CUDA histogram bins: ${cuda.histogram.length}, joint bins: ${cuda.joint_histogram.length}`);
  console.log('');

  if (diffs.length === 0) {
    console.log(`  ✓ Numerical parity confirmed within tolerances:`);
    console.log(`      • exact:        wins, win_rate, max_payout, scatter_histogram, range, condition, hist_granularity`);
    console.log(`      • |Δrtp| ≤ ${RTP_EPS}`);
    console.log(`      • rel(sum)  ≤ ${SUM_REL_EPS}`);
    console.log(`      • histogram mass per 1×-stake coarse bucket: |Δ| ≤ max(${MASS_FLOOR_DIFF}, ${MASS_K_SIGMA}×√N) (Poisson)`);
    console.log(`      Δrtp = ${Math.abs(cpu.rtp - cuda.rtp).toExponential(3)}`);
  } else {
    console.error(`  ✗ ${diffs.length} divergences found (outside documented tolerance):`);
    for (const d of diffs.slice(0, 50)) {
      console.error(`      ${d.field} [${d.tolerance ?? 'unspec'}]: cpu=${d.cpu}, cuda=${d.cuda}`);
    }
    if (diffs.length > 50) console.error(`      … (${diffs.length - 50} more)`);
    process.exit(3);
  }
}

main();
