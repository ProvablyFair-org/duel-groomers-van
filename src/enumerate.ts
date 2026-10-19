/**
 * Groomer's Van — exhaustive enumerator.
 *
 * Iterates outcomeIndex over [from, to) and computes the resulting spin
 * payout under base_game or bonus_game. Skips all MC bookkeeping. Just
 * the hot loop:
 *
 *   for (i = from; i < to; i++) {
 *     payout = spinPayout(i, condition)
 *     accumulate(payout)
 *   }
 */

import { Pcg32, generateGrid, generateMultipliers, REELS, ROWS, deriveTumbleSeed } from './rng';
import { findClusters, countScatters } from './cluster';
import { loadOperatorConfig } from './loader';
import { loadPaytable, clusterMultiplier, scatterMultiplier, type Paytable, type Condition } from './paytable';
import type { OperatorConfig } from './types';

// ── arg parsing ────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): { from: bigint; to: bigint; condition: Condition; reportEvery: bigint } {
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  const from = BigInt(a.from ?? '0');
  const to   = BigInt(a.to ?? String(1n << 32n));
  const condition: Condition = (a.condition ?? 'base') === 'bonus' ? 'bonus_game' : 'base_game';
  const reportEvery = BigInt(a.report ?? '1000000');
  return { from, to, condition, reportEvery };
}

// ── SymbolTables (copy of simulate.ts buildTables — not exported there) ────
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

// ── per-spin compute (matches simulate.ts spinPayout, lean — no maxWin tracking) ─
const MAX_WIN_X = 5000;

function spinPayout(outcomeIndex: number, paytable: Paytable, condition: Condition, tables: SymbolTables): number {
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

    // Multipliers in the new grid are drawn from the same per-cascade PCG32
    // stream right after the grid (per Duel spec). Only those landing on
    // top-filled positions (survivor-of-gravity) contribute to cumulativeBombs.
    const newMs = condition === 'bonus_game'
      ? generateMultipliers(newGrid, cascadePrng, tables.multiplierSymbolIndex, tables.multiplierValues, tables.multiplierWeights)
      : [];

    // gravity per column + top-fill
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
    for (const m of newMs) {
      if (filledNewPositions.has(m.position)) cumulativeBombs += m.value;
    }
    idxGrid = nextIdxGrid;
    codeGrid = nextCodeGrid;
    cumulativeScatters = countScatters(codeGrid);
  }

  // scatter pay (base game only) + bomb multiplier (bonus game only)
  let scatterPay = 0;
  if (condition === 'base_game' && cumulativeScatters >= 3) {
    scatterPay = scatterMultiplier(paytable, condition, cumulativeScatters);
  }
  const bombMult = condition === 'bonus_game' ? Math.max(cumulativeBombs, 1) : 1;

  let payout = totalBaseMult * bombMult + scatterPay;
  if (payout > MAX_WIN_X) payout = MAX_WIN_X;
  return payout;
}

// ── main enumeration loop ──────────────────────────────────────────────────
function main() {
  const { from, to, condition, reportEvery } = parseArgs(process.argv.slice(2));
  const cfg = loadOperatorConfig();
  const paytable = loadPaytable();
  const tables = buildTables(cfg, paytable, condition);

  const total = to - from;
  console.error(`enumerate: range=[${from}, ${to})  count=${total}  condition=${condition}`);

  let sum = 0;
  let wins = 0;
  let maxPayout = 0;
  const histogram = new Map<number, number>();

  const t0 = process.hrtime.bigint();
  let lastReport = t0;
  let lastReportI = from;

  for (let i = from; i < to; i++) {
    const payout = spinPayout(Number(i), paytable, condition, tables);
    sum += payout;
    if (payout > 0) wins++;
    if (payout > maxPayout) maxPayout = payout;
    const bucket = Math.floor(payout);
    histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1);

    if ((i - from) % reportEvery === 0n && i > from) {
      const now = process.hrtime.bigint();
      const intervalMs = Number(now - lastReport) / 1e6;
      const intervalSpins = Number(i - lastReportI);
      const spinsPerSec = intervalSpins / (intervalMs / 1000);
      const elapsedMs = Number(now - t0) / 1e6;
      const done = Number(i - from);
      const remaining = Number(to - i);
      const etaSec = remaining / spinsPerSec;
      console.error(
        `  i=${i.toString().padStart(13, ' ')}  ` +
        `(${(done / Number(total) * 100).toFixed(2)}%)  ` +
        `rate=${spinsPerSec.toFixed(0)}/s  ` +
        `elapsed=${(elapsedMs / 1000).toFixed(1)}s  ` +
        `eta=${(etaSec / 3600).toFixed(2)}h  ` +
        `running_rtp=${(sum / done).toFixed(6)}`
      );
      lastReport = now;
      lastReportI = i;
    }
  }

  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  const spinsTotal = Number(total);
  const rate = spinsTotal / (totalMs / 1000);

  console.error('');
  console.error(`done: spins=${spinsTotal}  elapsed=${(totalMs / 1000).toFixed(2)}s  rate=${rate.toFixed(0)}/s`);
  console.error(`     mean payout (RTP) = ${(sum / spinsTotal).toFixed(8)}`);
  console.error(`     win rate          = ${(wins / spinsTotal).toFixed(6)}  (${wins}/${spinsTotal})`);
  console.error(`     max payout        = ${maxPayout}`);
  console.error(`     histogram bins    = ${histogram.size}`);

  const histArr = Array.from(histogram.entries()).sort((a, b) => a[0] - b[0]);
  process.stdout.write(JSON.stringify({
    range: { from: from.toString(), to: to.toString(), count: spinsTotal },
    condition,
    sum, wins, maxPayout,
    rtp: sum / spinsTotal,
    winRate: wins / spinsTotal,
    histogram: histArr,
    elapsedSec: totalMs / 1000,
    spinsPerSec: rate,
  }) + '\n');
}

main();
