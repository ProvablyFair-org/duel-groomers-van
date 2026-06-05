/**
 * Dumps the GV constants needed by the CUDA enumerator into a single JSON
 * blob, structured so a C++/CUDA loader can consume it with no JS dependencies.
 *
 * Output (stdout): JSON with two top-level sections, one per condition.
 *   {
 *     "base_game":  { "weights": [[..]*6], "codes": [..], "wild_idx": .., "bonus_idx": .., "multiplier_idx": .., "payouts": {...}, "scatter_pay": {...} },
 *     "bonus_game": { ... + "multiplier_values": [..], "multiplier_weights": [..] }
 *   }
 *
 * The host C++ code parses this once at startup, copies the relevant
 * arrays into device __constant__ memory, then launches kernels.
 */

import { loadOperatorConfig } from './loader';
import { loadPaytable, type Condition } from './paytable';
import { REELS } from './rng';

function buildCondition(cfg: ReturnType<typeof loadOperatorConfig>, pt: ReturnType<typeof loadPaytable>, cond: Condition) {
  const symbols = [...cfg.weights.symbols_by_condition[cond]].sort((a, b) => a.symbol_index - b.symbol_index);
  const codes = symbols.map(s => s.code);
  // weights[reel][symbol_index] — per-reel weight for symbol idx
  const weights: number[][] = [];
  for (let r = 0; r < REELS; r++) weights.push(symbols.map(s => s.weights_per_reel[r]));

  const wildIdx       = symbols.findIndex(s => s.code === 'wild');
  const bonusIdx      = symbols.findIndex(s => s.code === 'bonus');
  const multiplierIdx = symbols.findIndex(s => s.code === 'multiplier');

  // payouts[symbol_index][cluster_size 8..12+] → multiplier. Use 0 where no payout.
  // Cluster size lookup: 8,9,10,11,12+ (any >=12 → 12 tier)
  const payouts: number[][] = symbols.map(s => {
    const row = [0, 0, 0, 0, 0]; // 8, 9, 10, 11, 12+
    const sym = pt.bySymbol[cond].get(s.code);
    if (!sym) return row;
    for (let sz = 8; sz <= 12; sz++) row[sz - 8] = sym.payoutByCount.get(sz) ?? 0;
    return row;
  });

  // scatter_pay[scatter_count 0..6+] → multiplier
  // Base game has scatter pay for 3/4/5/6+ scatters.
  const bonusSym = pt.bySymbol[cond].get('bonus');
  const scatterPay = [0, 0, 0, 0, 0, 0, 0]; // index 0..6 (6 = 6+)
  if (bonusSym) {
    for (let c = 3; c <= 6; c++) scatterPay[c] = bonusSym.payoutByCount.get(c) ?? 0;
  }

  return {
    codes,
    weights,
    wild_idx:       wildIdx,
    bonus_idx:      bonusIdx,
    multiplier_idx: multiplierIdx,
    n_symbols:      symbols.length,
    payouts,            // [n_symbols][5]
    scatter_pay:    scatterPay,
  };
}

function main() {
  const cfg = loadOperatorConfig();
  const pt  = loadPaytable();
  const base  = buildCondition(cfg, pt, 'base_game');
  const bonus = buildCondition(cfg, pt, 'bonus_game');

  const out = {
    n_reels: REELS,
    n_rows:  5,
    max_win_x:        5000,
    min_cluster_size: 8,
    base_game:  base,
    bonus_game: {
      ...bonus,
      multiplier_values:  pt.multiplierValuesList,
      multiplier_weights: pt.multiplierWeightsList,
    },
    // Session model — for the analytic step later, not the per-spin enumerator
    session: {
      free_spins_by_scatter: Array.from(pt.freeSpinsByScatter.entries()).sort((a, b) => a[0] - b[0]),
      retrigger_by_scatter:  Array.from(pt.retriggerByScatter.entries()).sort((a, b) => a[0] - b[0]),
      max_bonus_retriggers:  pt.maxBonusRetriggers,
      min_scatters_to_trigger: pt.minScattersToTrigger,
    },
  };
  process.stdout.write(JSON.stringify(out, null, 2));
}

main();
