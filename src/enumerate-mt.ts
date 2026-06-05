/**
 * Groomer's Van — multi-threaded exhaustive enumerator.
 *
 * Same per-spin compute as enumerate.ts, but uses node:worker_threads to
 * shard the range across N workers. The hot loop is fully parallel — each
 * outcome_index is independent — so speedup scales linearly with cores
 * until L3 / memory bandwidth bottlenecks.
 *
 * Emits the full CUDA-compatible artifact schema (range, condition, sum,
 * wins, max_payout, rtp, win_rate, elapsed_sec, hist_granularity=0.01,
 * histogram, scatter_histogram, joint_histogram) so that
 * `scripts/cpu-cuda-parity.ts` can verify the CPU enumeration matches the
 * committed CUDA output within documented numerical tolerances over the
 * full 2³² output space.
 *
 * Usage:
 *   ts-node src/enumerate-mt.ts --from 0 --to 1000000 --condition base --workers 8
 *   ts-node src/enumerate-mt.ts --condition base --out outputs/cpu-base-2pow32.json
 *
 * Each worker accumulates a partial { sum, wins, maxPayout, histogram,
 * scatterHistogram, jointHistogram } over its shard; the main thread
 * merges them at the end and writes the result either to stdout (no --out)
 * or to a file (--out PATH).
 */

import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import { Pcg32, generateGrid, generateMultipliers, REELS, ROWS, deriveTumbleSeed } from './rng';
import { findClusters, countScatters } from './cluster';
import { loadOperatorConfig } from './loader';
import { loadPaytable, clusterMultiplier, scatterMultiplier, type Paytable, type Condition } from './paytable';
import type { OperatorConfig } from './types';

// ── arg parsing ────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): { from: bigint; to: bigint; condition: Condition; workers: number; out: string | null } {
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return {
    from: BigInt(a.from ?? '0'),
    to:   BigInt(a.to ?? String(1n << 32n)),
    condition: (a.condition ?? 'base') === 'bonus' ? 'bonus_game' : 'base_game',
    workers: parseInt(a.workers ?? String(os.cpus().length), 10),
    out: a.out ?? null,
  };
}

// Granularity for the payout histogram — matches the CUDA artifact's
// `hist_granularity` field exactly. Buckets are `Math.floor(payout * 100)`.
const HIST_GRANULARITY = 0.01;
// scatter_histogram length — CUDA emits 8 bins (counts of 0..7 scatters per spin).
const SCATTER_BINS = 8;

// ── SymbolTables ───────────────────────────────────────────────────────────
interface SymbolTables {
  codes:   string[];
  weights: number[][];
  multiplierSymbolIndex: number;
  multiplierValues:      number[];
  multiplierWeights:     number[];
}

function buildTables(config: OperatorConfig, paytable: Paytable, condition: Condition): SymbolTables {
  const symbols = [...config.weights.symbols_by_condition[condition]]
    .sort((a, b) => a.symbol_index - b.symbol_index);
  const codes = symbols.map(s => s.code);
  const weights: number[][] = [];
  for (let r = 0; r < REELS; r++) weights.push(symbols.map(s => s.weights_per_reel[r]));
  const multIdx  = symbols.findIndex(s => s.code === 'multiplier');
  const multVals = condition === 'bonus_game' ? paytable.multiplierValuesList   : [];
  const multWts  = condition === 'bonus_game' ? paytable.multiplierWeightsList  : [];
  return { codes, weights, multiplierSymbolIndex: multIdx, multiplierValues: multVals, multiplierWeights: multWts };
}

// Default 5000× (the game's advertised max-win cap). Overridable via GV_MAX_WIN env
// var (inherited by worker threads) so the uncapped per-spin RTP can be measured for
// the audit's cap-impact analysis. Production/committed runs leave this at 5000.
const MAX_WIN_X = Number(process.env.GV_MAX_WIN ?? 5000);

function spinPayout(outcomeIndex: number, paytable: Paytable, condition: Condition, tables: SymbolTables): { payout: number; scatters: number } {
  const roundIndex = 0;
  let totalBaseMult = 0;
  let cumulativeBombs = 0;
  let tumbleIndex = 0;
  let tumbleSeed  = deriveTumbleSeed(outcomeIndex, roundIndex, tumbleIndex);
  let cascadePrng = new Pcg32(tumbleSeed);
  let idxGrid     = generateGrid(cascadePrng, tables.weights);

  let codeGrid: string[][] = idxGrid.map(col => col.map(i => tables.codes[i]));
  let cumulativeScatters = countScatters(codeGrid);

  if (condition === 'bonus_game') {
    const initialMultipliers = generateMultipliers(
      idxGrid, cascadePrng, tables.multiplierSymbolIndex, tables.multiplierValues, tables.multiplierWeights,
    );
    for (const m of initialMultipliers) cumulativeBombs += m.value;
  }

  for (let cascade = 0; cascade < 30; cascade++) {
    const clusters = findClusters(codeGrid);
    const removedSet = new Set<number>();
    for (const c of clusters) {
      // `paytable.minClusterSize` = 4 (operator's `rules.min_cluster_size`).
      // Effective PAYING minimum is 8 — per-symbol tables have no entries
      // for sizes 4–7, so `clusterMultiplier` returns 0 there and the
      // `baseMult <= 0` guard below skips removal.
      if (c.size < paytable.minClusterSize) continue;
      const baseMult = clusterMultiplier(paytable, condition, c.symbol, c.size);
      if (baseMult <= 0) continue;
      totalBaseMult += baseMult;
      for (const p of c.positions) removedSet.add(p);
    }
    if (removedSet.size === 0) break;

    tumbleIndex += 1;
    tumbleSeed   = deriveTumbleSeed(outcomeIndex, roundIndex, tumbleIndex);
    cascadePrng  = new Pcg32(tumbleSeed);
    const newGrid = generateGrid(cascadePrng, tables.weights);

    const newMs = condition === 'bonus_game'
      ? generateMultipliers(newGrid, cascadePrng, tables.multiplierSymbolIndex, tables.multiplierValues, tables.multiplierWeights)
      : [];

    const nextIdxGrid: number[][] = [];
    const nextCodeGrid: string[][] = [];
    const filledNewPositions = new Set<number>();
    for (let col = 0; col < REELS; col++) {
      const survivors: number[] = [];
      for (let row = 0; row < ROWS; row++) {
        const pos = col * ROWS + row;
        if (!removedSet.has(pos)) survivors.push(idxGrid[col][row]);
      }
      const empty = ROWS - survivors.length;
      const colNext: number[] = [];
      for (let row = 0; row < empty; row++) {
        colNext.push(newGrid[col][row]);
        filledNewPositions.add(col * ROWS + row);
      }
      colNext.push(...survivors);
      nextIdxGrid.push(colNext);
      nextCodeGrid.push(colNext.map(i => tables.codes[i]));
    }
    // Only multipliers landing on top-filled positions contribute bombs (matches simulate.ts)
    for (const m of newMs) {
      if (filledNewPositions.has(m.position)) cumulativeBombs += m.value;
    }
    idxGrid = nextIdxGrid;
    codeGrid = nextCodeGrid;
    cumulativeScatters = countScatters(codeGrid);
  }

  // Gate on the operator-published minScattersToTrigger; paytable absence of
  // entries below that count zeros the contribution naturally.
  let scatterPay = 0;
  if (condition === 'base_game' && cumulativeScatters >= paytable.minScattersToTrigger) {
    scatterPay = scatterMultiplier(paytable, condition, cumulativeScatters);
  }
  const bombMult = condition === 'bonus_game' ? Math.max(cumulativeBombs, 1) : 1;

  let payout = totalBaseMult * bombMult + scatterPay;
  if (payout > MAX_WIN_X) payout = MAX_WIN_X;
  return { payout, scatters: cumulativeScatters };
}

interface WorkerResult {
  sum: number;
  wins: number;
  maxPayout: number;
  // payout histogram at 0.01 granularity: [payoutBucket, count][]
  histogram: [number, number][];
  // 8-bin scatter count histogram (indices 0..7 = scatter counts 0..7)
  scatterHistogram: number[];
  // joint histogram at 0.01 payout granularity × scatter bin: [payoutBucket, scatterBin, count][]
  jointHistogram: [number, number, number][];
  spins: number;
}

function workerLoop(from: bigint, to: bigint, condition: Condition): WorkerResult {
  const cfg = loadOperatorConfig();
  const paytable = loadPaytable();
  const tables = buildTables(cfg, paytable, condition);

  let sum = 0, wins = 0, maxPayout = 0;
  const histogram = new Map<number, number>();
  const scatterHistogram = new Array<number>(SCATTER_BINS).fill(0);
  // Joint keyed by payoutBucket * 16 + scatterBin (scatterBin in [0, SCATTER_BINS), so 4 bits enough)
  // — using a packed integer key for Map lookups instead of string concat to keep the
  // hot loop allocation-free.
  const jointHistogram = new Map<number, number>();
  for (let i = from; i < to; i++) {
    const { payout, scatters } = spinPayout(Number(i), paytable, condition, tables);
    sum += payout;
    if (payout > 0) wins++;
    if (payout > maxPayout) maxPayout = payout;
    // Round-to-nearest matches `cuda/gv_cuda.cu`'s `(int)(p * 100.0 + 0.5)`
    // bucketing. Math.floor would underflow at IEEE 754 boundary payouts like
    // 2.30 (stored as 2.2999999…) and shift mass into the bucket below.
    const pb = Math.round(payout * 100);              // 0.01 granularity
    histogram.set(pb, (histogram.get(pb) ?? 0) + 1);
    const sb = scatters >= SCATTER_BINS ? SCATTER_BINS - 1 : scatters;
    scatterHistogram[sb]++;
    const jk = pb * 16 + sb;
    jointHistogram.set(jk, (jointHistogram.get(jk) ?? 0) + 1);
  }
  return {
    sum, wins, maxPayout,
    histogram: Array.from(histogram.entries()),
    scatterHistogram,
    jointHistogram: Array.from(jointHistogram.entries()).map(([jk, c]) => {
      const sb = jk & 15;
      const pb = (jk - sb) / 16;
      return [pb, sb, c] as [number, number, number];
    }),
    spins: Number(to - from),
  };
}

if (isMainThread) {
  const { from, to, condition, workers, out } = parseArgs(process.argv.slice(2));
  const total = to - from;
  const shardSize = total / BigInt(workers);
  console.error(`enumerate-mt: range=[${from}, ${to})  count=${total}  condition=${condition}  workers=${workers}  shard=${shardSize}  out=${out ?? '(stdout)'}`);

  const t0 = Date.now();
  const promises: Promise<WorkerResult>[] = [];

  for (let w = 0; w < workers; w++) {
    const shardFrom = from + shardSize * BigInt(w);
    const shardTo   = w === workers - 1 ? to : (shardFrom + shardSize);

    promises.push(new Promise((resolve, reject) => {
      const worker = new Worker(__filename, {
        workerData: { from: shardFrom.toString(), to: shardTo.toString(), condition },
        execArgv: ['-r', 'ts-node/register'],
      });
      worker.on('message', resolve);
      worker.on('error', reject);
      worker.on('exit', code => {
        if (code !== 0) reject(new Error(`worker ${w} exited ${code}`));
      });
    }));
  }

  Promise.all(promises).then(results => {
    const t1 = Date.now();
    let sum = 0, wins = 0, maxPayout = 0, totalSpins = 0;
    const histogram = new Map<number, number>();
    const scatterHistogram = new Array<number>(SCATTER_BINS).fill(0);
    const jointHistogram = new Map<number, number>();
    for (const r of results) {
      sum += r.sum;
      wins += r.wins;
      if (r.maxPayout > maxPayout) maxPayout = r.maxPayout;
      totalSpins += r.spins;
      for (const [k, v] of r.histogram) {
        histogram.set(k, (histogram.get(k) ?? 0) + v);
      }
      for (let i = 0; i < SCATTER_BINS; i++) scatterHistogram[i] += r.scatterHistogram[i];
      for (const [pb, sb, c] of r.jointHistogram) {
        const jk = pb * 16 + sb;
        jointHistogram.set(jk, (jointHistogram.get(jk) ?? 0) + c);
      }
    }
    const elapsedSec = (t1 - t0) / 1000;
    const rate = totalSpins / elapsedSec;

    // Sort histograms in the same canonical order CUDA emits (payout ASC; then scatter ASC for joint).
    const histArr = [...histogram.entries()].sort((a, b) => a[0] - b[0]);
    const jointArr = [...jointHistogram.entries()]
      .map(([jk, c]) => {
        const sb = jk & 15;
        const pb = (jk - sb) / 16;
        return [pb, sb, c] as [number, number, number];
      })
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    console.error('');
    console.error(`done: spins=${totalSpins}  elapsed=${elapsedSec.toFixed(2)}s  rate=${rate.toFixed(0)}/s  (across ${workers} workers)`);
    console.error(`     mean payout (RTP) = ${(sum / totalSpins).toFixed(8)}`);
    console.error(`     win rate          = ${(wins / totalSpins).toFixed(6)}  (${wins}/${totalSpins})`);
    console.error(`     max payout        = ${maxPayout}`);
    console.error(`     histogram bins    = ${histArr.length}`);
    console.error(`     joint bins        = ${jointArr.length}`);
    console.error(`     scatter bins      = ${scatterHistogram.map((c, i) => `${i}:${c}`).join(' ')}`);

    const payload = {
      range: { from: Number(from), to: Number(to), count: totalSpins },
      condition,
      sum,
      wins,
      max_payout: maxPayout,
      rtp: sum / totalSpins,
      win_rate: wins / totalSpins,
      elapsed_sec: elapsedSec,
      hist_granularity: HIST_GRANULARITY,
      histogram: histArr,
      scatter_histogram: scatterHistogram,
      joint_histogram: jointArr,
    };
    const json = JSON.stringify(payload);
    if (out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, json);
      console.error(`wrote ${out} (${(json.length / 1024).toFixed(1)} KB)`);
    } else {
      process.stdout.write(json + '\n');
    }
  }).catch(e => {
    console.error('worker error:', e);
    process.exit(1);
  });
} else {
  // worker thread entry
  const { from, to, condition } = workerData as { from: string; to: string; condition: Condition };
  const result = workerLoop(BigInt(from), BigInt(to), condition);
  parentPort!.postMessage(result);
}
