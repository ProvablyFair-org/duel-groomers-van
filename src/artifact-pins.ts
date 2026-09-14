/**
 * ARTIFACTS OF RECORD — pinned.
 *
 * These files are shipped as evidence and their figures are quoted in the report, but until this
 * pin existed nothing hashed them: emptying, duplicating or shrinking any of them left the
 * verifier reporting PROVABLY FAIR — Full Pass, exit 0. A published artifact that nothing can
 * distinguish from a rewritten one is not evidence.
 *
 * outputs/verification-results.json is deliberately NOT pinned — it is this verifier's own
 * output and is rewritten on every run by construction.
 *
 * Regenerating an artifact legitimately means re-pinning it here, in the same commit, with the
 * run that produced it.
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
  'bonus-session-ev.json':
    '3825f47da8873725071dae171df82462e395669454180303ef04258ce3692125',
  'cpu-base-2pow32.json':
    '2007a70eef5e6f6ebb23eb50eb1df0e7967a41b308fd7f49f330e6b7f3758ab7',
  'cpu-bonus-2pow32.json':
    '7f4b0f588723e48b8552e1dd240f1045a4df5144e4193736f3100faae8f8b086',
  'rtp-convergence.html':
    'd1c9c49f31f5bad44c11e65996e3c3a20738349f33c9256ba6a65a7eb6ea6c77',
  'simulation-results.json':
    '82d44770201891ca4438f78b1a38c17256229ca6be6cb41dfcc923ccf222616c',
});
