/**
 * CPU/CUDA byte-parity verification (Fix 3).
 *
 * Loads the CPU enumeration output produced by `npm run enumerate:cpu:base`
 * (or `:bonus`) and structurally compares it to the committed CUDA artifact
 * `outputs/{base,bonus}-2pow32.json`. Confirms every field matches:
 *
 *   - scalars: range, condition, sum, wins, max_payout, rtp, win_rate
 *   - hist_granularity: 0.01
 *   - histogram: length match + every (bucket, count) cell match
 *   - scatter_histogram: 8-element-wise match
 *   - joint_histogram: length match + every (payout_bucket, scatter_bin, count) cell match
 *
 * If all fields match → parity confirmed (the CUDA artifact is reproducible
 * on a 20-thread CPU enumerator without specialised hardware). If any field
 * diverges → real CPU/CUDA discrepancy surfaced, with first divergence
 * location reported.
 *
 * Also emits a canonical SHA-256 hash of the normalized contents (sorted
 * histograms, deterministic float-to-string serialization for the scalar
 * fields) so an external observer can verify the parity claim from the two
 * artifacts alone, without re-running this script.
 *
 * Usage:
 *   ts-node scripts/cpu-cuda-parity.ts --condition base
 *   ts-node scripts/cpu-cuda-parity.ts --condition bonus
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

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

/**
 * Canonical content hash. Float scalars are formatted to 12 significant
 * digits so trivial last-bit-of-mantissa differences from accumulation
 * order don't break the hash; all histogram cells are sorted then
 * serialised compactly.
 */
function canonicalHash(a: Artifact): string {
  function f(x: number): string {
    if (!isFinite(x)) return String(x);
    return Number(x.toPrecision(12)).toString();
  }
  const sortedHist  = [...a.histogram].sort((x, y) => x[0] - y[0]);
  const sortedJoint = [...a.joint_histogram].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const canon = [
    `range:${a.range.from},${a.range.to},${a.range.count}`,
    `condition:${a.condition}`,
    `sum:${f(a.sum)}`,
    `wins:${a.wins}`,
    `max_payout:${f(a.max_payout)}`,
    `rtp:${f(a.rtp)}`,
    `win_rate:${f(a.win_rate)}`,
    `hist_granularity:${f(a.hist_granularity)}`,
    `histogram:${sortedHist.map(([b, c]) => `${b}=${c}`).join('|')}`,
    `scatter_histogram:${a.scatter_histogram.join(',')}`,
    `joint_histogram:${sortedJoint.map(([b, s, c]) => `${b},${s}=${c}`).join('|')}`,
  ].join('\n');
  return crypto.createHash('sha256').update(canon).digest('hex');
}

interface Diff { field: string; cpu: unknown; cuda: unknown }

function compare(cpu: Artifact, cuda: Artifact): Diff[] {
  const diffs: Diff[] = [];
  const eq = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;

  // Scalars
  if (cpu.range.from !== cuda.range.from)   diffs.push({ field: 'range.from', cpu: cpu.range.from, cuda: cuda.range.from });
  if (cpu.range.to   !== cuda.range.to)     diffs.push({ field: 'range.to',   cpu: cpu.range.to,   cuda: cuda.range.to });
  if (cpu.range.count !== cuda.range.count) diffs.push({ field: 'range.count', cpu: cpu.range.count, cuda: cuda.range.count });
  if (cpu.condition  !== cuda.condition)    diffs.push({ field: 'condition',  cpu: cpu.condition,  cuda: cuda.condition });
  if (!eq(cpu.sum, cuda.sum, 1e-3))         diffs.push({ field: 'sum',        cpu: cpu.sum,        cuda: cuda.sum });
  if (cpu.wins !== cuda.wins)               diffs.push({ field: 'wins',       cpu: cpu.wins,       cuda: cuda.wins });
  if (!eq(cpu.max_payout, cuda.max_payout)) diffs.push({ field: 'max_payout', cpu: cpu.max_payout, cuda: cuda.max_payout });
  if (!eq(cpu.rtp, cuda.rtp, 1e-12))        diffs.push({ field: 'rtp',        cpu: cpu.rtp,        cuda: cuda.rtp });
  if (!eq(cpu.win_rate, cuda.win_rate, 1e-12)) diffs.push({ field: 'win_rate', cpu: cpu.win_rate, cuda: cuda.win_rate });
  if (!eq(cpu.hist_granularity, cuda.hist_granularity)) diffs.push({ field: 'hist_granularity', cpu: cpu.hist_granularity, cuda: cuda.hist_granularity });

  // histogram cell-by-cell
  const cpuH  = new Map<number, number>(cpu.histogram);
  const cudaH = new Map<number, number>(cuda.histogram);
  if (cpuH.size !== cudaH.size) {
    diffs.push({ field: 'histogram.length', cpu: cpuH.size, cuda: cudaH.size });
  }
  const buckets = new Set<number>([...cpuH.keys(), ...cudaH.keys()]);
  for (const b of [...buckets].sort((a, b) => a - b)) {
    const c1 = cpuH.get(b) ?? 0;
    const c2 = cudaH.get(b) ?? 0;
    if (c1 !== c2) diffs.push({ field: `histogram[bucket=${b}]`, cpu: c1, cuda: c2 });
    if (diffs.length > 25) break;
  }

  // scatter_histogram 8-element-wise
  for (let i = 0; i < Math.max(cpu.scatter_histogram.length, cuda.scatter_histogram.length); i++) {
    const c1 = cpu.scatter_histogram[i] ?? 0;
    const c2 = cuda.scatter_histogram[i] ?? 0;
    if (c1 !== c2) diffs.push({ field: `scatter_histogram[${i}]`, cpu: c1, cuda: c2 });
  }

  // joint_histogram cell-by-cell
  const cpuJ  = new Map<string, number>(cpu.joint_histogram.map(([b, s, c]) => [`${b}:${s}`, c]));
  const cudaJ = new Map<string, number>(cuda.joint_histogram.map(([b, s, c]) => [`${b}:${s}`, c]));
  if (cpuJ.size !== cudaJ.size) {
    diffs.push({ field: 'joint_histogram.length', cpu: cpuJ.size, cuda: cudaJ.size });
  }
  const jKeys = new Set<string>([...cpuJ.keys(), ...cudaJ.keys()]);
  for (const k of [...jKeys].sort()) {
    const c1 = cpuJ.get(k) ?? 0;
    const c2 = cudaJ.get(k) ?? 0;
    if (c1 !== c2) diffs.push({ field: `joint_histogram[${k}]`, cpu: c1, cuda: c2 });
    if (diffs.length > 50) break;
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

  console.log(`CPU/CUDA byte-parity check — condition=${condition}`);
  console.log(`  CPU file:  ${cpuPath}`);
  console.log(`  CUDA file: ${cudaPath}`);
  console.log('');

  const diffs = compare(cpu, cuda);

  console.log(`  CPU  range.count: ${cpu.range.count}, rtp: ${cpu.rtp.toFixed(10)}, max_payout: ${cpu.max_payout}`);
  console.log(`  CUDA range.count: ${cuda.range.count}, rtp: ${cuda.rtp.toFixed(10)}, max_payout: ${cuda.max_payout}`);
  console.log(`  CPU  histogram bins: ${cpu.histogram.length}, joint bins: ${cpu.joint_histogram.length}`);
  console.log(`  CUDA histogram bins: ${cuda.histogram.length}, joint bins: ${cuda.joint_histogram.length}`);
  console.log('');

  if (diffs.length === 0) {
    const hCpu  = canonicalHash(cpu);
    const hCuda = canonicalHash(cuda);
    console.log(`  ✓ All fields match. Parity confirmed.`);
    console.log(`    Canonical SHA-256: ${hCpu}`);
    console.log(`    CUDA matches:      ${hCuda === hCpu ? 'YES' : 'NO (CANONICAL HASH MISMATCH — investigate)'}`);
    if (hCpu !== hCuda) process.exit(2);
  } else {
    console.error(`  ✗ ${diffs.length} divergences found (capped display at first ~50):`);
    for (const d of diffs.slice(0, 50)) {
      console.error(`      ${d.field}: cpu=${d.cpu}, cuda=${d.cuda}`);
    }
    if (diffs.length > 50) console.error(`      … (${diffs.length - 50} more)`);
    process.exit(3);
  }
}

main();
