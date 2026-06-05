/**
 * Groomer's Van — paytable resolver.
 *
 * The cluster paytable maps (symbol, cluster_size) → multiplier. The
 * operator publishes it via `GET /api/v2/slots/groomers-van/rules`
 * (saved to `data/raw/paytable-from-rules-endpoint.json`) and again
 * via the in-game help panel (saved to
 * `data/raw/paytable-extracted-from-help.json`). Both sources agree.
 *
 * Cluster tiers are: 8, 9, 10, 11, 12+ (any cluster size ≥ 12 pays the
 * 12+ tier — confirmed from both sources). Min cluster size is 8.
 */

import * as fs   from 'fs';
import * as path from 'path';

const DATA_DIR    = path.join(__dirname, '..', 'data');
const RULES_PATH  = path.join(DATA_DIR, 'raw', 'paytable-from-rules-endpoint.json');

// ── Raw shape from /rules endpoint ──────────────────────────────────────────

interface RawPayout {
  symbol_count: number;
  multiplier:   string;     // "0.400000"
  line_type:    number;     // 0
}

interface RawSymbol {
  id:           number;
  code:         string;     // "symbol_5", "wild", "bonus", "multiplier"
  name:         string;
  symbol_index: number;
  type:         string;
  payouts:      RawPayout[];
}

interface RulesPayload {
  success: boolean;
  data: {
    game: { id: number; code: string; name: string; rows: number; columns: number; max_multiplier: string; rtp: string };
    symbols_by_condition: Record<'base_game' | 'bonus_game', RawSymbol[]>;
    rules: {
      win_type:                string;
      min_cluster_size:        number;
      tumbles_enabled:         boolean;
      min_scatters_to_trigger: number;
      multiplier_values:       Record<string, number>;
      spins_per_scatters:      Record<string, number>;
      retrigger?: {
        enabled:               boolean;
        min_scatters:          number;
        spins_per_scatters:    Record<string, number>;
        max_bonus_retriggers:  number;
      };
    };
  };
}

// ── Loaded paytable ─────────────────────────────────────────────────────────

export type Condition = 'base_game' | 'bonus_game';

export interface SymbolDef {
  code:         string;
  symbolIndex:  number;
  type:         string;
  /** Cluster size 8..12+ → multiplier (or scatter count → multiplier for the bonus symbol). 0 if no payout for that count. */
  payoutByCount: Map<number, number>;
}

export interface Paytable {
  game:                  { id: number; code: string; rows: number; columns: number; rtp: string; maxMultiplier: number };
  minClusterSize:        number;
  tumblesEnabled:        boolean;
  minScattersToTrigger:  number;
  multiplierValues:      Map<number, number>;     // multiplier value → operator-published weight
  multiplierValuesList:  number[];                // sorted multiplier values (for index lookup)
  multiplierWeightsList: number[];                // weights aligned to multiplierValuesList
  freeSpinsByScatter:    Map<number, number>;     // 3 → 8, 4 → 10, 5 → 12, 6 → 14
  retriggerByScatter:    Map<number, number>;     // 3 → 3, 4 → 5, 5 → 8, 6 → 10
  maxBonusRetriggers:    number;
  bySymbol:              Record<Condition, Map<string, SymbolDef>>;
  multiplierSymbolIndex: number;                  // 10 (in bonus_game)
  bonusSymbolCodes:      Set<string>;             // {'bonus'}
  wildCode:              string;
}

// ── Load + parse ────────────────────────────────────────────────────────────

export function loadPaytable(): Paytable {
  const raw = JSON.parse(fs.readFileSync(RULES_PATH, 'utf-8')) as RulesPayload;
  const d = raw.data;

  const buildSymbols = (cond: Condition): Map<string, SymbolDef> => {
    const m = new Map<string, SymbolDef>();
    for (const s of d.symbols_by_condition[cond]) {
      const payouts = new Map<number, number>();
      for (const p of s.payouts) {
        payouts.set(p.symbol_count, parseFloat(p.multiplier));
      }
      m.set(s.code, { code: s.code, symbolIndex: s.symbol_index, type: s.type, payoutByCount: payouts });
    }
    return m;
  };

  const bySymbol: Record<Condition, Map<string, SymbolDef>> = {
    base_game:  buildSymbols('base_game'),
    bonus_game: buildSymbols('bonus_game'),
  };

  const multValuesObj = d.rules.multiplier_values;
  const multValues   = Object.keys(multValuesObj).map(k => parseInt(k, 10)).sort((a, b) => a - b);
  const multWeights  = multValues.map(v => multValuesObj[String(v)]);
  const multValuesMap = new Map<number, number>();
  for (let i = 0; i < multValues.length; i++) multValuesMap.set(multValues[i], multWeights[i]);

  const freeSpinsByScatter = new Map<number, number>();
  for (const k of Object.keys(d.rules.spins_per_scatters)) {
    freeSpinsByScatter.set(parseInt(k, 10), d.rules.spins_per_scatters[k]);
  }
  const retriggerByScatter = new Map<number, number>();
  if (d.rules.retrigger?.spins_per_scatters) {
    for (const k of Object.keys(d.rules.retrigger.spins_per_scatters)) {
      retriggerByScatter.set(parseInt(k, 10), d.rules.retrigger.spins_per_scatters[k]);
    }
  }

  const multiplierSymbol = bySymbol.bonus_game.get('multiplier');

  return {
    game: {
      id:            d.game.id,
      code:          d.game.code,
      rows:          d.game.rows,
      columns:       d.game.columns,
      rtp:           d.game.rtp,
      maxMultiplier: parseFloat(d.game.max_multiplier),
    },
    minClusterSize:        d.rules.min_cluster_size,
    tumblesEnabled:        d.rules.tumbles_enabled,
    minScattersToTrigger:  d.rules.min_scatters_to_trigger,
    multiplierValues:      multValuesMap,
    multiplierValuesList:  multValues,
    multiplierWeightsList: multWeights,
    freeSpinsByScatter,
    retriggerByScatter,
    maxBonusRetriggers:    d.rules.retrigger?.max_bonus_retriggers ?? 0,
    bySymbol,
    multiplierSymbolIndex: multiplierSymbol?.symbolIndex ?? 10,
    bonusSymbolCodes:      new Set(['bonus']),
    wildCode:              'wild',
  };
}

// ── Multiplier resolver ─────────────────────────────────────────────────────

/**
 * Cluster pay multiplier for (symbol code, cluster size). Caps at the
 * 12+ tier — any cluster size ≥ 12 returns the 12-bucket multiplier.
 * Returns 0 for symbols with no payout (wild, multiplier) or sizes
 * below the minimum cluster size.
 */
export function clusterMultiplier(
  paytable: Paytable,
  condition: Condition,
  symbolCode: string,
  clusterSize: number,
): number {
  const sym = paytable.bySymbol[condition].get(symbolCode);
  if (!sym) return 0;
  if (clusterSize < paytable.minClusterSize) return 0;
  // Tier cap at 12 (the largest published bucket).
  const lookupSize = clusterSize >= 12 ? 12 : clusterSize;
  return sym.payoutByCount.get(lookupSize) ?? 0;
}

/**
 * Scatter (bonus symbol) multiplier for a given scatter count. The
 * bonus symbol's `payoutByCount` for {4: 3, 5: 5, 6: 100} (the help
 * panel + /rules endpoint) caps at 6+ — counts ≥ 6 pay 100×.
 */
export function scatterMultiplier(
  paytable: Paytable,
  condition: Condition,
  scatterCount: number,
): number {
  const sym = paytable.bySymbol[condition].get('bonus');
  if (!sym) return 0;
  const lookupCount = scatterCount >= 6 ? 6 : scatterCount;
  return sym.payoutByCount.get(lookupCount) ?? 0;
}

/**
 * Free-spin award for a given scatter count (3+/4+/5+/6+ → 8/10/12/14
 * for the initial trigger; 3/5/8/10 for retriggers per-`paytable.retriggerByScatter`).
 */
export function freeSpinsAwarded(paytable: Paytable, scatterCount: number, retrigger: boolean): number {
  const map = retrigger ? paytable.retriggerByScatter : paytable.freeSpinsByScatter;
  if (scatterCount < paytable.minScattersToTrigger) return 0;
  const lookup = scatterCount >= 6 ? 6 : scatterCount;
  return map.get(lookup) ?? 0;
}
