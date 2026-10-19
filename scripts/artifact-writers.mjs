/**
 * Writers of the pinned outputs/ artifacts that are NOT written as JSON.stringify(obj, null, 2).
 *
 * A pinned artifact must be byte-for-byte what its own generator writes, so that a regeneration with
 * identical values reproduces the pin (Framework 1.0, F19). The release check (check-duel-repo.mjs)
 * assumes JSON.stringify(obj, null, 2) unless a package declares otherwise here. Five artifacts in this
 * package come from two other writers:
 *
 *   - the 2^32 CUDA enumerator, cuda/gv_cuda.cu (run by scripts/run-cuda.sh), which prints its JSON with
 *     fprintf: doubles as %.17g, elapsed_sec as %.6f, integers as %llu / %d;
 *   - the CPU enumerator, src/enumerate-mt.ts (npm run enumerate:cpu:*; GV_MAX_WIN raised for the
 *     uncapped bonus run), which writes JSON.stringify(payload) with no indent and no trailing newline.
 *
 * Each entry names the writer's source file and the exact lines of it that `render` mirrors
 * (`mirrors`). The check requires every one of those lines to be present verbatim in the source, then
 * requires the artifact's bytes to equal render(JSON.parse(bytes)). An edit to the writer that is not
 * carried into `render`, or an artifact re-serialised by anything else, fails the check.
 */

/** C printf "%.17g" for a finite double (precision 17, trailing zeros and a bare '.' removed). */
function g17(v) {
  if (!Number.isFinite(v)) throw new Error(`%.17g of a non-finite value: ${v}`);
  if (v === 0) return Object.is(v, -0) ? '-0' : '0';
  const [mant, e] = v.toExponential(16).split('e');
  const x = Number(e);
  if (x < -4 || x >= 17) {
    const m = mant.includes('.') ? mant.replace(/0+$/, '').replace(/\.$/, '') : mant;
    return `${m}e${x < 0 ? '-' : '+'}${String(Math.abs(x)).padStart(2, '0')}`;
  }
  const f = v.toFixed(16 - x);
  return f.includes('.') ? f.replace(/0+$/, '').replace(/\.$/, '') : f;
}

/** C printf "%.6f". */
const f6 = (v) => v.toFixed(6);

/** cuda/gv_cuda.cu, the `if (out_path)` block: one fprintf per line below, in the same order. */
function renderCuda(o) {
  let s = '{\n';
  s += `  "range": {"from": ${o.range.from}, "to": ${o.range.to}, "count": ${o.range.count}},\n`;
  s += `  "condition": "${o.condition}",\n`;
  s += `  "sum": ${g17(o.sum)},\n`;
  s += `  "wins": ${o.wins},\n`;
  s += `  "max_payout": ${g17(o.max_payout)},\n`;
  s += `  "rtp": ${g17(o.rtp)},\n`;
  s += `  "win_rate": ${g17(o.win_rate)},\n`;
  s += `  "elapsed_sec": ${f6(o.elapsed_sec)},\n`;
  s += '  "hist_granularity": 0.01,\n';
  s += '  "histogram": [' + o.histogram.map(([b, n]) => `[${b},${n}]`).join(',');
  s += '],\n  "scatter_histogram": [' + o.scatter_histogram.join(',');
  s += '],\n  "joint_histogram": [' + o.joint_histogram.map(([b, k, n]) => `[${b},${k},${n}]`).join(',');
  s += ']\n}\n';
  return s;
}

const CUDA_MIRRORS = [
  'fprintf(f, "{\\n");',
  'fprintf(f, "  \\"range\\": {\\"from\\": %llu, \\"to\\": %llu, \\"count\\": %llu},\\n",',
  'fprintf(f, "  \\"condition\\": \\"%s\\",\\n", bonus ? "bonus_game" : "base_game");',
  'fprintf(f, "  \\"sum\\": %.17g,\\n", sum);',
  'fprintf(f, "  \\"wins\\": %llu,\\n", (unsigned long long)wins);',
  'fprintf(f, "  \\"max_payout\\": %.17g,\\n", max_payout);',
  'fprintf(f, "  \\"rtp\\": %.17g,\\n", sum / count);',
  'fprintf(f, "  \\"win_rate\\": %.17g,\\n", (double)wins / count);',
  'fprintf(f, "  \\"elapsed_sec\\": %.6f,\\n", elapsed);',
  'fprintf(f, "  \\"hist_granularity\\": 0.01,\\n");',
  'fprintf(f, "  \\"histogram\\": [");',
  'if (!first) fprintf(f, ",");',
  'fprintf(f, "[%d,%llu]", b, (unsigned long long)histogram[b]);',
  'fprintf(f, "],\\n  \\"scatter_histogram\\": [");',
  'if (s) fprintf(f, ",");',
  'fprintf(f, "%llu", (unsigned long long)scatter_hist[s]);',
  'fprintf(f, "],\\n  \\"joint_histogram\\": [");',
  'fprintf(f, "[%d,%d,%llu]", b, s, (unsigned long long)joint_hist[b][s]);',
  'fprintf(f, "]\\n}\\n");',
];

const CPU_MIRRORS = [
  'const json = JSON.stringify(payload);',
  'fs.writeFileSync(out, json);',
];

const cuda = { source: 'cuda/gv_cuda.cu', how: 'fprintf (%.17g doubles, %.6f elapsed_sec)', mirrors: CUDA_MIRRORS, render: renderCuda };
const cpu = { source: 'src/enumerate-mt.ts', how: 'JSON.stringify(payload), no indent, no trailing newline', mirrors: CPU_MIRRORS, render: (o) => JSON.stringify(o) };

/** outputs/<file> → its writer. */
export const ARTIFACT_WRITERS = Object.freeze({
  'base-2pow32.json': cuda,
  'bonus-2pow32.json': cuda,
  'cpu-base-2pow32.json': cpu,
  'cpu-bonus-2pow32.json': cpu,
  'bonus-2pow32-uncapped.json': cpu,
});
