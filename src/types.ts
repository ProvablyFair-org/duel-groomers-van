/**
 * Groomer's Van — TypeScript types for the captured dataset.
 *
 * These mirror the live API shapes verbatim. Field names are kept exactly
 * as the operator returns them (snake_case) so the verifier can compare
 * raw responses without transformations.
 */

// ── Card / cell payload ─────────────────────────────────────────────────────

export interface Cell {
  uuid:             string;
  id:               number;
  symbol:           string;             // e.g. "symbol_5", "wild", "bonus", "multiplier"
  index:            number;             // row within the reel column
  round:            number;
  removed_on_round: number | null;      // null if still on screen at spin end
  position:         number;             // 0..29 column-major (col * ROWS + row)
  type:             string;             // "common" | "rare" | "epic" | "premium" | "wild" | "scatter" | "tumble_multiplier"
  multiplier_value: string | null;      // multiplier-symbol value in bonus mode
}

export interface Payline {
  win_type:              'cluster' | 'scatter';
  identifier:            string;        // "cluster_symbol_1_10", "scatter_bonus_4", …
  symbol:                string;
  symbol_name:           string;
  count:                 number;        // cluster size (or scatter count)
  multiplier:            number;        // base multiplier from paytable
  payout_coins:          string;        // bet × multiplier × bomb_multiplier (in coins)
  payout_currency:       string;        // 18-decimal USD precision
  bomb_multiplier:       number | null; // sticky-multiplier sum (bonus only)
  base_payout_coins:     string;
  base_payout_currency:  string;
}

export interface Round {
  id:   number;
  type: 'regular' | 'tumble' | 'bonus_game' | string;
  data: {
    spin_multiplier: string;            // sticky-multiplier sum applied to this round
    view:            Cell[][];          // view[reel][row]
    paylines:        Payline[];
  };
}

// ── Feature session (bonus state) ───────────────────────────────────────────

export interface FeatureTriggerData {
  spin_id:                  number;
  scatter_count:            number;
  scatter_payout:           string;
  trigger_tumble:           number;
  scatter_positions:        string[];   // positions are stored as decimal strings in the API
  scatter_payout_currency:  string;
}

export interface FeatureStatus {
  feature_id:                  number;
  feature_key:                 string;     // "bonus_game"
  current_spin:                number;     // 0..N
  remaining_spins:             number;
  current_win_coins:           string;
  current_win_currency:        string;
  balance_type:                number;
  trigger_bet_amount_currency: string;
  trigger_bet_amount_coins:    string;
  trigger_data:                FeatureTriggerData;
  last_spin_id:                number | null;
  replay_data:                 unknown;    // server-side state for resume; opaque to verifier
}

// ── Spin response (POST /api/v2/slots/groomers-van/spin or /buy) ────────────

export interface SpinResponse {
  spin_id:               number;
  spin_type:             'base_game' | 'bonus_game';
  bet_amount:            string;
  bet_amount_currency:   string;        // canonical 18-decimal stake
  balance_type:          number;        // 105 = USDC
  total_win:             string;
  total_win_currency:    string;
  total_multiplier:      string;
  feature_triggered:     boolean;
  respin_data: {
    respin_triggered:    boolean;
    scatter_positions:   number[] | null;
    awarded_spins:       number | null;
  };
  rounds:                Round[];
  feature_status:        FeatureStatus | null;
  max_win_reached:       boolean;
  edge_multiplier:       string;        // "1" at zero-edge bracket; > 1 at higher stakes
  amount_won_coins:      string;
  amount_won:            string;
}

// ── Pre-bet seed snapshot (GET /api/v2/client-seed) ─────────────────────────

export interface ActiveAtSpin {
  client_seed:            string;
  server_seed_hashed:     string;
  next_server_seed_hash:  string;
  nonce:                  number;       // epoch-local 0..49
}

// ── /verify response (per-spin reproduction info) ──────────────────────────

export interface VerifyTumble {
  tumble_index: number;
  round_index:  number;
  pf_nonce:     number;
  type:         'initial' | 'tumble' | string;
  grid:         unknown[][];            // operator-side per-cell data; opaque
}

export interface VerifyData {
  spin_id:           number;
  spin_type:         string;
  pf_skipped:        boolean;            // true on the cosmetic first spin of a bought bonus
  nonce:             number;
  round_index:       number;
  outcome_index:     number;
  outcome_index_hex: string;
  tumbles:           VerifyTumble[];
  server_seed:       string;
  server_seed_hash:  string;
  client_seed:       string;
  bet_amount?:       string;
  win_amount?:       string;
  _verify_session?: {
    trigger_spin_id:      number;
    feature_session_id:   number | null;
    is_bonus_buy:         boolean;
    is_feature_session:   boolean;
  };
}

// ── Captured bet record (one entry in dataset.bets) ─────────────────────────

export type BetMode = 'spin' | 'buy' | 'free_spin' | 'preflight-drain';

export interface GVBet {
  spinId:         number;
  phase:          string;             // 'A' | 'B' | 'C' | 'D' | 'E' | 'preflight-drain'
  mode:           BetMode;
  triggerSpinId?: number;             // free_spin → links back to the buy/trigger
  featureId?:    number;
  requestedStake: string;
  startedAt:      string;
  activeAtSpin:   ActiveAtSpin;
  response:       SpinResponse;
  nonce:          number | null;
  verifyData?:    VerifyData;
}

// ── Captured seed-rotation entry (one entry in dataset.seeds) ───────────────

export interface SeedRotation {
  at:            string;
  context:       string;              // e.g. "rotate-phase-A", "rotate-phase-final"
  phase:         string;
  seed: {
    clientSeed:         string;
    serverSeedHashed:   string;
    nextServerSeedHash: string;
    serverSeed:         string | null;
  };
  nonce:                 number;
  prevSpinId?:           number | null;
  prevSpinSeedRevealed?: string | null;
  verified?: Array<{
    spinId:           number;
    serverSeed:       string | null;
    serverSeedHashed: string | null;
    totalSpins:       number;
    isFeatureSession: boolean;
    isBonusBuy:       boolean;
    spinsCount:       number;
    spins:            VerifyData[] | null;
  }>;
}

// ── Raw HTTP event (one entry in dataset.events) ────────────────────────────

export interface RawEvent {
  ts:              string;
  method:          string;
  path:            string;
  requestBody:     unknown;
  httpStatus:      number;
  httpStatusText:  string;
  responseBody:    unknown;
  phaseAtCall?:    string | null;
}

// ── Dataset envelope ────────────────────────────────────────────────────────

export interface DatasetMeta {
  game:        string;
  capturedAt:  string;
  mode:        string;
  phasesRun:   unknown[];
  betCount:    number;
  seedCount:   number;
  eventCount?: number;
}

export interface GVDataset {
  meta:   DatasetMeta;
  bets:   GVBet[];
  seeds:  SeedRotation[];
  events: RawEvent[];
}

// ── Operator config from /api/v2/slots ──────────────────────────────────────

export interface ScalingEdgeBracket {
  id:         number;
  config_id:  number;
  min_bet:    string;
  max_bet:    string;
  house_edge: string;
}

export interface ReelWeights {
  reelIndex:     number;
  symbolWeights: number[];   // weights[symbolIndex] for this reel
}

export interface OperatorConfig {
  id:               number;
  code:             string;
  name:             string;
  active_version:   string;
  rtp:              string;
  min_bet:          string;
  max_bet:          string;
  max_multiplier:   string;
  features: Array<{
    code: string;
    name: string;
    type: string;
    metadata: {
      can_retrigger:               boolean;
      max_retriggers:              number;
      scatter_rewards:             Record<string, number>;
      buy_scatter_count:           number;
      multiplier_values:           Record<string, number>;
      retrigger_rewards:           Record<string, number>;
      multiplier_bombs_enabled:    boolean;
      buy_awards_scatter_payout:   boolean;
    };
    is_buyable:    boolean;
    description:   string;
    buy_multiplier: number;
  }>;
  mechanics: {
    has_wilds:                       boolean;
    pay_mechanic:                    string;     // 'cluster'
    reel_mechanic:                   string;     // 'tumbling'
    min_cluster_size:                number;     // 8
    skipped_symbol_types:            string[];   // e.g. ["scatter"]
    symbols_paying_logic:            string;     // 'anywhere'
    multiplier_bombs_enabled:        boolean;
    multiplier_bombs_applies_to:     string;     // 'feature'
    multiplier_bombs_symbol_type:    string;     // 'tumble_multiplier'
  };
  weights: {
    symbols_by_condition: Record<'base_game' | 'bonus_game', Array<{
      code:           string;
      symbol_index:   number;
      weights_per_reel: number[];   // 6 reels
    }>>;
    symbol_distributions_by_condition: Record<'base_game' | 'bonus_game', ReelWeights[]>;
  };
  symbols: Record<string, {
    id:           number;
    code:         string;
    name:         string;
    symbol_index: number;
    type:         string;
  }>;
  rtp_per_condition:  Record<string, string>;
  scaling_edge:       Record<'base_game' | 'bonus_game', ScalingEdgeBracket[]>;
}
