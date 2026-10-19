/**
 * PLAYER-VERIFIER PARITY (profile GROOMERS-24) — the ProvablyFair.org docs-site verifier.
 *
 * The docs site ships a player-facing verifier for Duel Groomer's Van: the VerifyBets component, whose
 * derivation is `src/components/VerifyBets/games/groomers-van/derive.js`, which imports
 * `lib/hmac-sha256.js` (the pure-JS HMAC) and `./paytables.js` (the site's copy of the operator config:
 * reel weights, paytable, multiplier weights, trigger tables, max-win cap). A player who pastes a bet into
 * that page is trusting THAT code, not this package's src/rng.ts.
 *
 * WHAT THIS FILE DOES (ported 2026-09-26 from Duel Dice / Mines / Beef src/site-verifier.ts, widened to
 * the two imports this derivation carries).
 *   1. PINS the SHA-256 of all three site files (SITE_VERIFIER_PINS).
 *   2. Holds a VENDORED copy of those exact bytes under verifier-parity/, laid out as on the site.
 *      The vendored bytes must hash to the pins or Step 5 FAILs before anything runs.
 *   3. EXECUTES the vendored derive.js — not a re-typing of it — on every captured base spin (Step 5).
 *
 * HOW THE VENDORED ES MODULES ARE RUN. The suite is synchronous CommonJS; the site files are ES modules
 * with extensionless relative imports. Each is evaluated with node:vm in its own function scope after
 * exactly two textual rewrites of the in-memory copy (never the hashed file): its import lines — which
 * must equal IMPORT_LINES byte for byte, any other import set FAILs — are replaced by bindings to the
 * vendored modules, and `export ` is dropped from each top-level declaration.
 *
 * PROVENANCE OF THE PINNED BYTES (read 2026-09-26, read-only, via `git cat-file -p origin/main:<path>`):
 *   repository  qa-workspace/duel/docusaurus (mikepforg/pf-audit-duel), origin/main
 *               @ bd4d59cd9a3e75146f2575c5218a3fb9a8b2692d (2026-09-19). derive.js and paytables.js were last
 *               changed on main in 4aaa1b2 (2026-06-07). The local checkout's HEAD copies differ from main's
 *               only in the source-URL comment (github.com/ProvablyFair/… → github.com/ProvablyFair-org/…);
 *               hmac-sha256.js is byte-identical to the copy Duel Dice pins (bc30bfe9…).
 *   The LIVE page (www.provablyfair.org/verify-bets) is a separate build and is NOT checked here.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

export const SITE_VERIFIER_DIR = path.join(__dirname, '../verifier-parity');

export const SITE_VERIFIER_PINS: Readonly<Record<string, string>> = Object.freeze({
  'games/groomers-van/derive.js':    '095e552b08add4efb56181c2261ef586d037eee22508e2eea32373b1497ce632',
  'games/groomers-van/paytables.js': '57fd0e4ac6abd986a06a7bd977e864214d48991e588d4c075e71796c50271469',
  'lib/hmac-sha256.js':              'bc30bfe9ef202905ece93de33440d41851abf16e910f90c2a567774a2b79d889',
});

export const SITE_VERIFIER_PROVENANCE = Object.freeze({
  siteRoot: 'qa-workspace/duel/docusaurus/src/components/VerifyBets',
  repository: 'mikepforg/pf-audit-duel',
  ref: 'origin/main',
  head: 'bd4d59cd9a3e75146f2575c5218a3fb9a8b2692d',
  headDate: '2026-09-19',
  deriveLastChanged: '4aaa1b267a6b86199c46f57db41058c7885067bb (2026-06-07)',
  readVia: 'git cat-file -p origin/main:<path>',
  readOn: '2026-09-26',
});

/** The only imports derive.js may carry. Anything else is code this check does not vendor. */
export const IMPORT_LINES: readonly string[] = Object.freeze([
  "import { hmacSha256Hex, hexToBytes } from '../../lib/hmac-sha256';",
  "import { CONFIG, REELS, ROWS, MAX_WIN_X } from './paytables';",
]);

export interface SiteGVResult {
  spinType: string;
  outcomeIndex: number;
  trigger: { payout: number; triggered: boolean; cumulativeScatters: number; maxWinReached: boolean } | null;
  session: { sessionPayout: number } | null;
  triggered: boolean;
  payout: number;
  maxWinReached: boolean;
}
export type SiteDeriveGV = (p: { clientSeed: string; serverSeed: string; nonce: number; spinType?: string }) => SiteGVResult;
export type SiteOutcomeIndex = (serverSeed: string, clientSeed: string, nonce: number) => number;
export type SiteTumbleSeed = (outcomeIndex: number, roundIndex: number, tumbleIndex: number) => number;

export interface SiteVerifierLoad {
  files: Array<{ file: string; pinned: string; actual: string | null; match: boolean }>;
  hashesMatch: boolean;
  deriveGroomersVan: SiteDeriveGV | null;
  computeOutcomeIndex: SiteOutcomeIndex | null;
  deriveTumbleSeed: SiteTumbleSeed | null;
  maxWinX: number | null;
  error: string | null;
}

const sha256 = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');
const stripExports = (src: string): string => src.replace(/^export (function|const|let|class) /gm, '$1 ');

export function loadSiteVerifier(dir = SITE_VERIFIER_DIR): SiteVerifierLoad {
  const none = { deriveGroomersVan: null, computeOutcomeIndex: null, deriveTumbleSeed: null, maxWinX: null };
  const files = Object.entries(SITE_VERIFIER_PINS).map(([file, pinned]) => {
    const p = path.join(dir, file);
    const actual = fs.existsSync(p) ? sha256(fs.readFileSync(p)) : null;
    return { file, pinned, actual, match: actual === pinned };
  });
  const hashesMatch = files.every(f => f.match);
  if (!hashesMatch) return { files, hashesMatch, ...none, error: 'vendored site verifier does not match its pinned SHA-256' };
  try {
    const libSrc = fs.readFileSync(path.join(dir, 'lib/hmac-sha256.js'), 'utf8');
    const lib = (vm.runInThisContext(
      `(function () {\n${stripExports(libSrc)}\n;return { hmacSha256Hex, hexToBytes };\n})`,
      { filename: 'verifier-parity/lib/hmac-sha256.js' },
    ) as () => { hmacSha256Hex: unknown; hexToBytes: unknown })();

    const ptSrc = fs.readFileSync(path.join(dir, 'games/groomers-van/paytables.js'), 'utf8');
    if (ptSrc.split('\n').some(l => /^\s*import\b/.test(l))) {
      return { files, hashesMatch, ...none, error: 'paytables.js carries an import this check does not vendor' };
    }
    const pt = (vm.runInThisContext(
      `(function () {\n${stripExports(ptSrc)}\n;return { CONFIG, REELS, ROWS, MAX_WIN_X };\n})`,
      { filename: 'verifier-parity/games/groomers-van/paytables.js' },
    ) as () => { CONFIG: unknown; REELS: unknown; ROWS: unknown; MAX_WIN_X: number })();

    const deriveSrc = fs.readFileSync(path.join(dir, 'games/groomers-van/derive.js'), 'utf8');
    const importLines = deriveSrc.split('\n').filter(l => /^\s*import\b/.test(l));
    if (importLines.length !== IMPORT_LINES.length || importLines.some((l, i) => l !== IMPORT_LINES[i])) {
      return { files, hashesMatch, ...none,
        error: `derive.js imports ${JSON.stringify(importLines)}; the vendored imports are ${JSON.stringify(IMPORT_LINES)}` };
    }
    let body = deriveSrc;
    for (const l of IMPORT_LINES) body = body.replace(l, '');
    const mod = (vm.runInThisContext(
      `(function (hmacSha256Hex, hexToBytes, CONFIG, REELS, ROWS, MAX_WIN_X) {\n${stripExports(body)}\n;return { deriveGroomersVan, computeOutcomeIndex, deriveTumbleSeed };\n})`,
      { filename: 'verifier-parity/games/groomers-van/derive.js' },
    ) as (...a: unknown[]) => { deriveGroomersVan: SiteDeriveGV; computeOutcomeIndex: SiteOutcomeIndex; deriveTumbleSeed: SiteTumbleSeed })(
      lib.hmacSha256Hex, lib.hexToBytes, pt.CONFIG, pt.REELS, pt.ROWS, pt.MAX_WIN_X);
    if (typeof mod.deriveGroomersVan !== 'function' || typeof mod.computeOutcomeIndex !== 'function' || typeof mod.deriveTumbleSeed !== 'function') {
      return { files, hashesMatch, ...none, error: 'derive.js does not define deriveGroomersVan / computeOutcomeIndex / deriveTumbleSeed' };
    }
    return { files, hashesMatch, deriveGroomersVan: mod.deriveGroomersVan, computeOutcomeIndex: mod.computeOutcomeIndex,
      deriveTumbleSeed: mod.deriveTumbleSeed, maxWinX: pt.MAX_WIN_X, error: null };
  } catch (e) {
    return { files, hashesMatch, ...none, error: `vendored site verifier failed to evaluate: ${(e as Error).message}` };
  }
}
