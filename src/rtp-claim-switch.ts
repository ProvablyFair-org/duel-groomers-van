/**
 * RTP-CLAIM enforcement switch for this package, read by ./rtp-claim.
 *
 *   false  the RTP-CLAIM outcome and the per-setting table are computed and printed as INFO;
 *          no verdict moves.
 *   true   the outcome is scored on the game profile's -19 check: a miss is OVERSTATED and the
 *          package verdict RTP FIGURE OVERSTATED (rule 1.2.0); NO_CLAIM, NOTED and PUBLISHED stay
 *          INFO either way.
 *
 * ./rtp-claim is a byte-identical copy of the framework rule (conformance C-13 compares SHA-256s);
 * this file is the only per-package part of it. bin/sync-rtp-claim.mjs creates it with false when
 * it is missing and never overwrites it.
 */
export const RTP_CLAIM_RULE_ENFORCED: boolean = true;
