/**
 * ARTIFACTS OF RECORD — pinned.
 *
 * These files are shipped as evidence and their figures are quoted in the report, but until this
 * pin existed nothing hashed most of them: emptying, duplicating or shrinking any of them left the
 * verifier reporting PROVABLY FAIR — Full Pass, exit 0. A published artifact that nothing can
 * distinguish from a rewritten one is not evidence. Steps 29–31 pin the enumeration and session-EV
 * inputs to the headline RTP; Step 33 pins EVERY tracked artifact under outputs/, including the
 * Monte Carlo cross-check (simulation-results.json) that Steps 16–18 score against and the
 * convergence chart the report links to.
 *
 * outputs/verification-results.json is deliberately NOT pinned — it is this verifier's own
 * output. It is protected differently: a run writes under outputs/run/ and the reproduction gate
 * in tests/verify.ts diffs it field by field against the committed copy.
 *
 * Regenerating an artifact legitimately means re-pinning it here, in the same commit, with the
 * run that produced it (PF_EMIT=1 npm run simulate for the Monte Carlo pair; the enumerate:* and
 * session-ev-exact:* scripts for the rest).
 *
 * Pins recomputed 2026-09-23 from the tracked files in this workshop (sha256sum outputs/<file>).
 *
 * simulation-results.json RE-PINNED 2026-09-26 (previous pin 12def9ca…): its two run-metadata fields —
 * `generatedAt` and `pass2.forwardReplay.executionTimeMs` — were deleted with Node's JSON.parse /
 * JSON.stringify(…, null, 2), the serializer src/simulate.ts writes with, which round-trips the original
 * bytes exactly; git diff shows those two lines removed and nothing else. src/simulate.ts no longer
 * writes either field (profile GROOMERS-27, conformance C-04). The 2^32 enumeration artifacts still
 * carry `elapsed_sec` (run metadata) — not stripped here: they are produced by the CUDA/CPU enumerators
 * and pinned twice (here and in tests/steps/enumeration.ts); disclosed in MANIFEST.md.
 *
 * rtp-convergence.html RE-PINNED 2026-09-28 (previous pin d1c9c49f…): Chart.js 4.4.7 is inlined verbatim
 * (Mike's review F16) instead of loaded from cdn.jsdelivr.net. Regenerated with `PF_EMIT=1 npm run simulate`;
 * simulation-results.json came back byte-identical (4becfea4…) and the html diff is the one <script> tag.
 *
 * rtp-convergence.html RE-PINNED 2026-10-19 (previous pin 71afebab…): the reference line was the operator's
 * 100% claim (config.rtp) labelled "Theoretical"; it is now the exact 2^32 figure from deriveEnumeratedRtp
 * (99.9720%) and the claim is named beside it (Mike's QA, 19 Oct 2026). Regenerated with
 * `PF_EMIT=1 npm run simulate`; simulation-results.json came back byte-identical (4becfea4…) and the html diff
 * is the legend, the theoretical stat tile and the `theoretical` constant.
 */
export const ARTIFACT_PINS: Readonly<Record<string, string>> = Object.freeze({
  'base-2pow32.json':
    '0b890eef7153fcdf14c69d8559de8d3f50af558e5464974627db2103ee22d5a1',
  'bonus-2pow32-uncapped.json':
    'aff462d1f8104584d830ba2ab849657c0109f90e6461de79c043f89f77afe1a3',
  'bonus-2pow32.json':
    'e878256256cf59edb458d6ec0f5b1cc5ea6e2d45764636676362345d4cdfdb14',
  'bonus-session-ev-exact-10.json':
    'a03b4e024b1182ad62e64739e47069b2a4d302430f9153a9d1f26d8104072257',
  'bonus-session-ev-exact-12.json':
    '334e55e3183065cd0e3a0e5157f11d8d37e5f1ad435e8d4d91083028c8905fda',
  'bonus-session-ev-exact-14.json':
    '79236fe8facf3b6ab33238a51a121f333f80bb38e0ec9361a5585fd81bc97461',
  'bonus-session-ev-exact-8.json':
    '15a11d74e7fc10e4426bb013e4d5e1f9204e2620cf5307f51ba8f7c01b4945e2',
  'bonus-session-ev-exact.json':
    '139ea735aa4fd7f6b59f87fcb5538a9381b7261d26101aba80e7c7d58bcb0e2a',
  'bonus-session-ev.json':
    '3825f47da8873725071dae171df82462e395669454180303ef04258ce3692125',
  'cpu-base-2pow32.json':
    '2007a70eef5e6f6ebb23eb50eb1df0e7967a41b308fd7f49f330e6b7f3758ab7',
  'cpu-bonus-2pow32.json':
    '7f4b0f588723e48b8552e1dd240f1045a4df5144e4193736f3100faae8f8b086',
  'rtp-convergence.html':
    '89e63d82d12a212e63529066f92954c0421a494caf9d9759155aafa7becc8165',
  'simulation-results.json':
    '4becfea46f75bb5715343cfad9ee0de64f5438eb6823975c981c7facb930c8cf',
});
