/**
 * RTP-CLAIM wiring — Duel Groomer's Van: the per-setting RTP table and the claim it is held to.
 *
 * The rule is src/rtp-claim.ts, a byte-identical copy of the framework's core/rtp-claim.ts (its
 * SHA-256 is compared by conformance C-13), version 1.2.0 (Methodology v1.1, agreed 2026-10-14;
 * 1.0.0 agreed on Slack 2026-09-29). The enforcement switch RTP_CLAIM_RULE_ENFORCED is the
 * package's own src/rtp-claim-switch.ts, set to true (decision D3): the outcome is scored on the
 * step carrying GROOMERS-19, and a house-side miss makes the verdict RTP FIGURE OVERSTATED (exit 5),
 * never NOT PROVABLY FAIR. The claim names one of the rule's six places: the game settings.
 *
 * SETTINGS. One: a paid spin (base game plus the free-spin bonus it triggers). The stake does not
 * change the reels. The bonus BUY is a second way in whose spin grid is operator-canned (DL-3), so
 * its RTP is not derivable here and it is not in this table.
 * RTP. The headline derivation Step 32 scores (tests/steps/enumeration.ts deriveEnumeratedRtp):
 * base RTP from the exhaustive 2^32 enumeration + P(trigger) × E[session | trigger] from the exact
 * lane convolution. It is computed in double precision from the pinned enumeration artifacts; the
 * rule takes that double's exact binary value (rationalFromDouble). Its own numerical error
 * (the convolution's rounding bound is printed by Step 16) is far inside the 0.1 pp band.
 * CLAIM. Flat 100 %, a stated RTP in the game settings (decision D2): "rtp": "100.0000" in Duel's
 * Groomer's Van game config v1.4 (data/raw/groomers-van-config-v1.4.json:9; declaration
 * gameModel.edge.claimed 0).
 *
 *   npm run rtp-claim:write    rewrite outputs/rtp-claim-table.json and print its SHA-256 to pin
 */
import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';
import { RtpClaim, RtpClaimAccumulator, RtpClaimResult, rtpClaimTable, rtpClaimGate, RtpClaimGate, rationalFromDouble } from './rtp-claim';
import { deriveEnumeratedRtp } from '../tests/steps/enumeration';

export const RTP_CLAIM: RtpClaim = {
  kind: 'flat',
  rtp: '1',
  source: 'game settings: "rtp": "100.0000" in Duel\'s Groomer\'s Van game config v1.4 (data/raw/groomers-van-config-v1.4.json:9; declaration gameModel.edge.claimed 0)',
};

/** The scored step that carries GROOMERS-19 (src/profile-map.ts). */
export const RTP_CLAIM_STEP = 32;

export const RTP_CLAIM_TABLE = path.join(__dirname, '..', 'outputs', 'rtp-claim-table.json');
/** SHA-256 of the committed table — re-pin with the run that rewrote it (npm run rtp-claim:write). */
export const RTP_CLAIM_TABLE_SHA256 = '58de71cb6dc34e2e758bcc5596813a459cad8657c5c3d7b8a4b584b92895588a';

export function computeRtpClaim(): RtpClaimResult {
  const e = deriveEnumeratedRtp(path.join(__dirname, '..', 'outputs'));
  if (!e) throw new Error('rtp-claim: the pinned enumeration artifacts are missing (Steps 29–31)');
  const acc = new RtpClaimAccumulator(RTP_CLAIM);
  const r = rationalFromDouble(e.totalRtp);
  acc.add('paid spin (base game + triggered bonus)', r.n, r.d);
  return acc.result();
}

export function rtpClaimTableText(r: RtpClaimResult): string {
  return rtpClaimTable(r, {
    package: 'duel/groomers-van', game: 'groomers-van',
    settingSpace: 'one setting: a paid spin (the bonus buy is not derivable — canned spin grid, DL-3 — and is not in the table)',
    rtpMethod: 'base RTP (exhaustive 2^32) + P(trigger) × E[session | trigger] (exact lane convolution), in double precision; the rule is exact on that double',
  });
}

export function runRtpClaimGate(): RtpClaimGate {
  const r = computeRtpClaim();
  return rtpClaimGate(r, rtpClaimTableText(r), RTP_CLAIM_TABLE, RTP_CLAIM_TABLE_SHA256);
}

if (require.main === module) {
  const text = rtpClaimTableText(computeRtpClaim());
  fs.writeFileSync(RTP_CLAIM_TABLE, text);
  console.log(`wrote outputs/rtp-claim-table.json sha256 ${createHash('sha256').update(text).digest('hex')}`);
}
