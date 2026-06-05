/**
 * Per-outcome_index payout dumper for parity checks vs the CUDA enumerator.
 * Prints "outcome_index payout" per line, one outcome per line, to stdout.
 *
 * Usage:
 *   npx ts-node src/gv-dump-payouts.ts --from 0 --to 100 --condition base
 *   npx ts-node src/gv-dump-payouts.ts --from 0 --to 100 --condition bonus
 */

import { Pcg32, generateGrid, generateMultipliers, REELS, ROWS, deriveTumbleSeed } from './rng';
import { findClusters, countScatters } from './cluster';
import { loadOperatorConfig } from './loader';
import { loadPaytable, clusterMultiplier, scatterMultiplier, type Paytable, type Condition } from './paytable';
import type { OperatorConfig } from './types';

interface SymbolTables {
  codes: string[];
  weights: number[][];
  multiplierSymbolIndex: number;
  multiplierValues: number[];
  multiplierWeights: number[];
}

function buildTables(config: OperatorConfig, paytable: Paytable, condition: Condition): SymbolTables {
  const symbols = [...config.weights.symbols_by_condition[condition]].sort((a, b) => a.symbol_index - b.symbol_index);
  const codes = symbols.map(s => s.code);
  const weights: number[][] = [];
  for (let r = 0; r < REELS; r++) weights.push(symbols.map(s => s.weights_per_reel[r]));
  const multIdx  = symbols.findIndex(s => s.code === 'multiplier');
  const multVals = condition === 'bonus_game' ? paytable.multiplierValuesList   : [];
  const multWts  = condition === 'bonus_game' ? paytable.multiplierWeightsList  : [];
  return { codes, weights, multiplierSymbolIndex: multIdx, multiplierValues: multVals, multiplierWeights: multWts };
}

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
    const initialMultipliers = generateMultipliers(idxGrid, cascadePrng, tables.multiplierSymbolIndex, tables.multiplierValues, tables.multiplierWeights);
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
    // Only multipliers on top-filled (survivor-of-gravity) positions contribute bombs
    for (const m of newMs) {
      if (filledNewPositions.has(m.position)) cumulativeBombs += m.value;
    }
    idxGrid = nextIdxGrid;
    codeGrid = nextCodeGrid;
    cumulativeScatters = countScatters(codeGrid);
  }

  let scatterPay = 0;
  if (condition === 'base_game' && cumulativeScatters >= 3) {
    scatterPay = scatterMultiplier(paytable, condition, cumulativeScatters);
  }
  const bombMult = condition === 'bonus_game' ? Math.max(cumulativeBombs, 1) : 1;

  let payout = totalBaseMult * bombMult + scatterPay;
  if (payout > MAX_WIN_X) payout = MAX_WIN_X;
  return payout;
}

function main() {
  const args: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) { args[process.argv[i].slice(2)] = process.argv[i + 1]; i++; }
  }
  const from = parseInt(args.from ?? '0', 10);
  const to   = parseInt(args.to ?? '100', 10);
  const condition: Condition = (args.condition ?? 'base') === 'bonus' ? 'bonus_game' : 'base_game';

  const cfg = loadOperatorConfig();
  const paytable = loadPaytable();
  const tables = buildTables(cfg, paytable, condition);

  for (let i = from; i < to; i++) {
    const p = spinPayout(i, paytable, condition, tables);
    // Print with 6 decimal places — matches what the CUDA --dump outputs
    process.stdout.write(`${i} ${p.toFixed(6)}\n`);
  }
}

main();
