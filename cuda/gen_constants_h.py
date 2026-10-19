#!/usr/bin/env python3
"""Generate gv_constants.h from gv-constants.json — single source of truth for CUDA + host."""
import json, sys

with open('/tmp/gv-constants.json') as f:
    d = json.load(f)

out = [
    '// GENERATED — do not edit. Source: gv-constants.json (TS dump).',
    '#pragma once',
    '#include <cstdint>',
    '',
    f'constexpr int N_REELS = {d["n_reels"]};',
    f'constexpr int N_ROWS  = {d["n_rows"]};',
    f'constexpr int GRID_SIZE = N_REELS * N_ROWS;  // 30',
    f'constexpr double MAX_WIN_X = {d["max_win_x"]}.0;',
    f'constexpr int MIN_CLUSTER_SIZE = {d["min_cluster_size"]};',
    '',
]

def emit_condition(cond, dat):
    n_sym = dat['n_symbols']
    out.append(f'// ── {cond} ──')
    out.append(f'constexpr int {cond.upper()}_N_SYMBOLS = {n_sym};')
    out.append(f'constexpr int {cond.upper()}_WILD_IDX = {dat["wild_idx"]};')
    out.append(f'constexpr int {cond.upper()}_BONUS_IDX = {dat["bonus_idx"]};')
    out.append(f'constexpr int {cond.upper()}_MULT_IDX = {dat["multiplier_idx"]};')
    out.append('')
    # weights[reel][symbol] flat
    out.append(f'__device__ __constant__ uint32_t {cond.upper()}_WEIGHTS[N_REELS][{n_sym}] = {{')
    for r in dat['weights']:
        out.append('    {' + ', '.join(str(w) for w in r) + '},')
    out.append('};')
    # cumulative weights per reel (for faster pick) + per-reel total
    out.append(f'__device__ __constant__ uint32_t {cond.upper()}_CUM_WEIGHTS[N_REELS][{n_sym}] = {{')
    for r in dat['weights']:
        cum = []
        acc = 0
        for w in r:
            acc += w
            cum.append(acc)
        out.append('    {' + ', '.join(str(c) for c in cum) + '},')
    out.append('};')
    out.append(f'__device__ __constant__ uint32_t {cond.upper()}_REEL_TOTAL[N_REELS] = {{')
    out.append('    ' + ', '.join(str(sum(r)) for r in dat['weights']))
    out.append('};')
    # payouts[symbol][cluster_size - 8 in [0..4]]
    out.append(f'__device__ __constant__ double {cond.upper()}_PAYOUTS[{n_sym}][5] = {{')
    for sym_payouts in dat['payouts']:
        out.append('    {' + ', '.join(f'{p:.17g}' if isinstance(p, float) else f'{p}.0' for p in sym_payouts) + '},')
    out.append('};')
    # scatter pay [0..6+]
    out.append(f'__device__ __constant__ double {cond.upper()}_SCATTER_PAY[7] = {{')
    out.append('    ' + ', '.join(f'{p:.17g}' if isinstance(p, float) else f'{p}.0' for p in dat['scatter_pay']))
    out.append('};')
    out.append('')

emit_condition('BASE', d['base_game'])
emit_condition('BONUS', d['bonus_game'])

# multiplier values for bonus mode
n_mv = len(d['bonus_game']['multiplier_values'])
out.append(f'constexpr int N_MULT_VALUES = {n_mv};')
out.append(f'__device__ __constant__ uint32_t MULT_VALUES[N_MULT_VALUES] = {{')
out.append('    ' + ', '.join(str(v) for v in d['bonus_game']['multiplier_values']))
out.append('};')
out.append(f'__device__ __constant__ uint32_t MULT_WEIGHTS[N_MULT_VALUES] = {{')
out.append('    ' + ', '.join(str(v) for v in d['bonus_game']['multiplier_weights']))
out.append('};')
out.append(f'__device__ __constant__ uint32_t MULT_CUM_WEIGHTS[N_MULT_VALUES] = {{')
acc, cum = 0, []
for w in d['bonus_game']['multiplier_weights']:
    acc += w
    cum.append(acc)
out.append('    ' + ', '.join(str(v) for v in cum))
out.append('};')
out.append(f'__device__ __constant__ uint32_t MULT_TOTAL = {acc};')

print('\n'.join(out))
