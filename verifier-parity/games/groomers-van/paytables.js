/**
 * Duel Groomer's Van payout tables — extracted verbatim from the audit
 * `EMBEDDED_CONFIG` (v1.4) in the standalone verifier and from the
 * canonical paytable in
 *   https://github.com/ProvablyFair-org/duel-groomers-van/blob/main/src/paytable.ts
 *
 * These are the operator-supplied weights and cluster paytables for both
 * the base game and the bonus (free-spin) game, captured during audit and
 * confirmed to match the values served live by the game API.
 *
 * If Duel updates their config, this file must be regenerated from a fresh
 * config pull and the audit repo updated in lockstep — never hand-edit.
 */

// Grid shape (column-major: REELS columns × ROWS rows, 30 cells total).
export const REELS = 6;
export const ROWS = 5;

// Capped per-spin/per-session payout, in stake multiples.
export const MAX_WIN_X = 5000;

export const CONFIG = {
  game_code: 'groomers-van',
  version: 'v1.4',
  reels: 6,
  rows: 5,
  min_cluster_size: 8,
  min_scatters_to_trigger: 3,
  max_win: 5000,
  max_bonus_retriggers: 3,
  buy_scatter_count: 4,
  buy_multiplier: 125,
  buy_awards_scatter_payout: true,
  spins_per_scatters: { 3: 8, 4: 10, 5: 12, 6: 14 },
  retrigger_spins_per_scatters: { 3: 3, 4: 5, 5: 8, 6: 10 },
  multiplier_values_weights: {
    2: 90, 3: 25, 4: 18, 5: 13, 6: 10, 7: 8, 8: 7,
    10: 6, 12: 5, 15: 4, 25: 4, 50: 4, 100: 3, 250: 3,
  },
  base_game: {
    symbol_codes: [
      'symbol_1', 'symbol_2', 'symbol_3', 'symbol_4', 'symbol_5',
      'symbol_6', 'symbol_7', 'symbol_8', 'symbol_9', 'wild', 'bonus',
    ],
    weights_per_reel: [
      [88, 92, 72, 65, 52, 42, 43, 39, 26, 8, 3],
      [110903, 96200, 62000, 63000, 46000, 42000, 51000, 44000, 17000, 8000, 4900],
      [734, 839, 520, 540, 460, 230, 470, 310, 351, 122, 55],
      [64, 77, 52, 41, 31, 29, 42, 45, 27, 8, 5],
      [82, 72, 74, 51, 52, 42, 63, 28, 31, 8, 5],
      [480, 412, 360, 300, 265, 135, 320, 276, 62, 80, 18],
    ],
    paytable: {
      symbol_1: { 8: 0.4, 9: 0.4, 10: 0.6, 11: 0.7, 12: 2.0 },
      symbol_2: { 8: 0.5, 9: 0.6, 10: 0.7, 11: 1.0, 12: 2.5 },
      symbol_3: { 8: 0.6, 9: 0.7, 10: 0.9, 11: 1.2, 12: 3.0 },
      symbol_4: { 8: 0.7, 9: 0.9, 10: 1.2, 11: 1.5, 12: 4.0 },
      symbol_5: { 8: 1.0, 9: 1.2, 10: 1.5, 11: 2.0, 12: 5.0 },
      symbol_6: { 8: 1.5, 9: 1.6, 10: 2.2, 11: 2.8, 12: 7.0 },
      symbol_7: { 8: 1.8, 9: 2.2, 10: 2.8, 11: 3.5, 12: 9.0 },
      symbol_8: { 8: 2.5, 9: 3.5, 10: 4.5, 11: 5.5, 12: 14.0 },
      symbol_9: { 8: 5.0, 9: 6.0, 10: 8.0, 11: 10.0, 12: 25.0 },
    },
    scatter_pay: { 4: 3, 5: 5, 6: 100 },
    bonus_symbol_index: 10,
    multiplier_symbol_index: null,
  },
  bonus_game: {
    symbol_codes: [
      'symbol_1', 'symbol_2', 'symbol_3', 'symbol_4', 'symbol_5',
      'symbol_6', 'symbol_7', 'symbol_8', 'symbol_9', 'wild',
      'multiplier', 'bonus',
    ],
    weights_per_reel: [
      [143, 72, 79, 86, 33, 45, 50, 31, 20, 5, 14, 3],
      [4448, 5769, 1840, 3440, 1400, 540, 2960, 1480, 1120, 428, 632, 120],
      [129, 206, 59, 51, 30, 12, 43, 24, 24, 11, 16, 3],
      [1349, 1351, 433, 773, 262, 170, 714, 352, 235, 117, 153, 26],
      [194, 68, 72, 74, 84, 11, 52, 21, 12, 4, 10, 3],
      [175, 66, 120, 43, 36, 30, 48, 41, 10, 8, 12, 3],
    ],
    paytable: {
      symbol_1: { 8: 0.4, 9: 0.4, 10: 0.6, 11: 0.7, 12: 2.0 },
      symbol_2: { 8: 0.5, 9: 0.6, 10: 0.7, 11: 1.0, 12: 2.5 },
      symbol_3: { 8: 0.6, 9: 0.7, 10: 0.9, 11: 1.2, 12: 3.0 },
      symbol_4: { 8: 0.7, 9: 0.9, 10: 1.2, 11: 1.5, 12: 4.0 },
      symbol_5: { 8: 1.0, 9: 1.2, 10: 1.5, 11: 2.0, 12: 5.0 },
      symbol_6: { 8: 1.5, 9: 1.6, 10: 2.2, 11: 2.8, 12: 7.0 },
      symbol_7: { 8: 1.8, 9: 2.2, 10: 2.8, 11: 3.5, 12: 9.0 },
      symbol_8: { 8: 2.5, 9: 3.5, 10: 4.5, 11: 5.5, 12: 14.0 },
      symbol_9: { 8: 5.0, 9: 6.0, 10: 8.0, 11: 10.0, 12: 25.0 },
    },
    scatter_pay: { 4: 3, 5: 5, 6: 100 },
    bonus_symbol_index: 11,
    multiplier_symbol_index: 10,
  },
};

// Human-friendly symbol names for the Viz overlay and hover tooltips.
export const SYMBOL_NAMES = {
  symbol_1: 'Lollipop',
  symbol_2: 'Gem',
  symbol_3: 'Shield',
  symbol_4: 'Jelly',
  symbol_5: 'Candy',
  symbol_6: 'Photograph',
  symbol_7: 'VHS tape',
  symbol_8: 'Binoculars',
  symbol_9: 'Camera',
  wild: 'Wild',
  multiplier: 'Multiplier',
  bonus: 'Bonus scatter',
};

// Short letter glyphs for grid cells — one character per symbol so cells
// stay readable at small sizes. Wild/multiplier/bonus get distinct glyphs.
export const SYMBOL_GLYPHS = {
  symbol_1: '1',
  symbol_2: '2',
  symbol_3: '3',
  symbol_4: '4',
  symbol_5: '5',
  symbol_6: '6',
  symbol_7: '7',
  symbol_8: '8',
  symbol_9: '9',
  wild: 'W',
  multiplier: '×',
  bonus: '★',
};
