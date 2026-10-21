/**
 * Spec self-test: docs/ALGORITHM.md vectors and properties, run against src/rng.ts.
 *
 * Written by the clean-room implementer together with src/rng.ts, from docs/ALGORITHM.md and the module
 * interface alone (never from Duel's code). Integrated 20 Oct 2026: the checks are unchanged; only the
 * import path, the mocha wrapper and the reporting (failures collected instead of printed) were adapted.
 * Its own header, kept as written:
 */
// Self-test for rng.ts against every worked vector in ALGORITHM.md §2.2, §2.3, §2.4a, §2.4b and §5, plus properties.
// Clusters, removal, gravity and totals (§3) are evaluated here only to carry the vectors from one tumble to the
// next and to check the vectors' stated outcomes; they are not part of rng.ts.

import { createHash, createHmac } from "crypto";
import {
  REELS, ROWS, Pcg32, SymbolGrid, acceptedDraw, computeOutcomeIndex, deriveTumbleSeed, generateGrid,
  generateMultipliers, hashServerSeed, pickWeighted, reproduceSpin,
} from "../../src/rng";
import * as assert from 'assert';

const EXPECTED_CHECKS = 166;

function runSelftest(): { pass: number; total: number; failed: string[] } {
  let pass = 0;
  let total = 0;
  const failed: string[] = [];
  function check(name: string, ok: boolean, detail = ""): void {
    total++;
    if (ok) pass++;
    if (!ok) failed.push(`${name}${detail ? "  " + detail : ""}`);
  }
  const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  const hex8 = (n: number): string => (n >>> 0).toString(16).padStart(8, "0");
  const hex16 = (n: bigint): string => n.toString(16).padStart(16, "0");

  // §2.4 tables, rows = symbol index, columns = reel 0..5; transposed to per-reel lists.
  const BASE_ROWS = [
    [88, 110903, 734, 64, 82, 480], [92, 96200, 839, 77, 72, 412], [72, 62000, 520, 52, 74, 360],
    [65, 63000, 540, 41, 51, 300], [52, 46000, 460, 31, 52, 265], [42, 42000, 230, 29, 42, 135],
    [43, 51000, 470, 42, 63, 320], [39, 44000, 310, 45, 28, 276], [26, 17000, 351, 27, 31, 62],
    [8, 8000, 122, 8, 8, 80], [3, 4900, 55, 5, 5, 18],
  ];
  const BONUS_ROWS = [
    [143, 4448, 129, 1349, 194, 175], [72, 5769, 206, 1351, 68, 66], [79, 1840, 59, 433, 72, 120],
    [86, 3440, 51, 773, 74, 43], [33, 1400, 30, 262, 84, 36], [45, 540, 12, 170, 11, 30],
    [50, 2960, 43, 714, 52, 48], [31, 1480, 24, 352, 21, 41], [20, 1120, 24, 235, 12, 10],
    [5, 428, 11, 117, 4, 8], [14, 632, 16, 153, 10, 12], [3, 120, 3, 26, 3, 3],
  ];
  const perReel = (rows: number[][]): number[][] => [0, 1, 2, 3, 4, 5].map((r) => rows.map((row) => row[r]));
  const BASE = perReel(BASE_ROWS);
  const BONUS = perReel(BONUS_ROWS);
  const WILD = 9;
  const BASE_BONUS = 10;
  const BONUS_MULT = 10;
  const BONUS_BONUS = 11;
  const MULT_TABLE: Array<[number, number]> = [[2, 90], [3, 25], [4, 18], [5, 13], [6, 10], [7, 8], [8, 7], [10, 6],
    [12, 5], [15, 4], [25, 4], [50, 4], [100, 3], [250, 3]];
  const MULT_LIST = MULT_TABLE.flatMap(([v, w]) => Array<number>(w).fill(v));
  const MULT_VALUES = MULT_TABLE.map(([v]) => v);
  const MULT_WEIGHTS = MULT_TABLE.map(([, w]) => w);
  // §3.3 paytable, tiers 8, 9, 10, 11, 12+.
  const PAY = [[0.4, 0.4, 0.6, 0.7, 2.0], [0.5, 0.6, 0.7, 1.0, 2.5], [0.6, 0.7, 0.9, 1.2, 3.0], [0.7, 0.9, 1.2, 1.5, 4.0],
    [1.0, 1.2, 1.5, 2.0, 5.0], [1.5, 1.6, 2.2, 2.8, 7.0], [1.8, 2.2, 2.8, 3.5, 9.0], [2.5, 3.5, 4.5, 5.5, 14.0],
    [5.0, 6.0, 8.0, 10.0, 25.0]];

  // §5 grid notation: five "/"-separated rows top to bottom, six reels left to right.
  interface Cell { sym: number; mult: number | null }
  function parseGrid(text: string, bonus: boolean): Cell[][] {
    const rows = text.split("/").map((r) => r.trim().split(/\s+/));
    const grid: Cell[][] = [];
    for (let col = 0; col < REELS; col++) {
      const column: Cell[] = [];
      for (let row = 0; row < ROWS; row++) {
        const tok = rows[row][col];
        if (tok === "W") column.push({ sym: WILD, mult: null });
        else if (tok === "B") column.push({ sym: bonus ? BONUS_BONUS : BASE_BONUS, mult: null });
        else if (tok.startsWith("Mx")) column.push({ sym: BONUS_MULT, mult: Number(tok.slice(2)) });
        else column.push({ sym: Number(tok.slice(1)) - 1, mult: null });
      }
      grid.push(column);
    }
    return grid;
  }

  interface RoundV { t: number; ts: string; st: string; hash: string; grid: string; wins: Array<[number, number, number]>; removed: number[] }
  interface SpinV {
    name: string; seed: string; commit: string; client: string; nonce: number; round: number; bonus: boolean;
    oi: number; oiHex: string; rounds: RoundV[]; tm: number; currency: number; scatters?: number[]; awarded?: number;
    scatterPay?: number; M?: number;
  }

  const V3SEED = "a6f8de3ed0adf0bbbc4d2c5af73041919868c4f786f572568787c792a2f5e029";
  const V3COMMIT = "08e6584aba3d698ed8659faabec500e477a1657379b1bb081e891202fcbdbc47";
  const VECTORS: SpinV[] = [
    {
      name: "V1", seed: "230ba817fa7535d716b67a15e7cfbccbeb0cd0104b4e118c9bbf131d276fbe8f",
      commit: "4665995d6e3e03a83c42cd0427693f2e78c7b7283bdf35a3d463481fee252a21",
      client: "pf_jaTw5uQPC05yB", nonce: 49, round: 0, bonus: false, oi: 4268979530, oiHex: "fe73754a",
      rounds: [
        { t: 0, ts: "c16f6d0c", st: "fab4b2311f120e7b", hash: "e0890224720444d8",
          grid: "S2 S3 S4 S8 S3 S5 / S2 S2 S5 S3 S6 S2 / S3 S1 S2 S1 S5 S2 / S2 S8 S4 S3 S7 S8 / S1 S8 S9 S2 S9 S4",
          wins: [[2, 8, 0.5]], removed: [0, 1, 3, 6, 12, 19, 26, 27] },
        { t: 1, ts: "35d31d7d", st: "3ce47377bee744fd", hash: "41e52708292c3854",
          grid: "S2 S4 S7 S3 S3 S8 / S1 S3 S4 S8 S6 W / S3 S1 S5 S3 S5 S5 / S3 S8 S4 S1 S7 S8 / S1 S8 S9 S3 S9 S4",
          wins: [[3, 8, 0.6]], removed: [2, 3, 6, 15, 17, 19, 20, 26] },
        { t: 2, ts: "242ebed7", st: "e649c38447a3774d", hash: "aaf404b4c44ceac0",
          grid: "S1 S4 S7 S2 S5 S4 / S1 S4 S4 S2 S6 S8 / S2 S1 S5 S4 S5 S5 / S1 S8 S4 S8 S7 S8 / S1 S8 S9 S1 S9 S4",
          wins: [], removed: [] },
      ],
      tm: 1.1, currency: 0.22, scatters: [], scatterPay: 0,
    },
    {
      name: "V2", seed: "a81baf3e7dee56be7fca67da83a809eabe5423e5b2a44bc66762b3500080b9a8",
      commit: "0b742c5c9410cb762cf801b218d57e79e4ef238973cdfec99f46990de5965219",
      client: "pf_r3UgUo9TKL8ea", nonce: 5, round: 0, bonus: false, oi: 3016396169, oiHex: "b3ca8d89",
      rounds: [
        { t: 0, ts: "025f71ae", st: "23152207a1ebf17b", hash: "e10181c3e19c115b",
          grid: "S3 S7 S1 S6 S3 S4 / S4 B S1 S2 S8 S3 / S2 S4 S6 S9 S1 B / S6 S1 S6 S9 B S4 / S6 S4 S9 S2 S3 B",
          wins: [], removed: [] },
      ],
      tm: 3, currency: 0.6, scatterPay: 3, awarded: 10,
    },
    {
      name: "V3", seed: V3SEED, commit: V3COMMIT, client: "pf_raPBrzfw4Gi48", nonce: 40, round: 0, bonus: false,
      oi: 848081699, oiHex: "328cb323",
      rounds: [
        { t: 0, ts: "fdd6f183", st: "01eacf00c1dffe91", hash: "82b9aac41d56ab92",
          grid: "S2 S7 S3 S1 S3 S2 / B W S6 S7 S2 S5 / S2 S2 S4 S4 S9 S1 / S3 S1 S1 S8 S1 S2 / S1 S1 S3 B S1 S1",
          wins: [[1, 10, 0.6]], removed: [4, 6, 8, 9, 13, 15, 23, 24, 27, 29] },
        { t: 1, ts: "33236083", st: "56a1b0a5f47dae51", hash: "208c42d1e5e3a03a",
          grid: "S6 S7 S8 S1 S1 B / S2 S1 S3 S7 S3 S2 / B S7 S6 S4 S3 S2 / S2 S7 S4 S8 S2 S5 / S3 S2 S3 B S9 S2",
          wins: [], removed: [] },
      ],
      tm: 0.6, currency: 0.12, scatters: [2, 19, 25], scatterPay: 0, awarded: 8,
    },
    {
      name: "V4", seed: V3SEED, commit: V3COMMIT, client: "pf_raPBrzfw4Gi48", nonce: 40, round: 5, bonus: true,
      oi: 848081699, oiHex: "328cb323",
      rounds: [
        { t: 0, ts: "5b743e8d", st: "7c53915a49cbb5d4", hash: "82b9aac41d56ab92",
          grid: "S4 S3 S2 S2 S5 S1 / S1 S2 S4 S1 S1 S2 / S1 S5 S6 S5 S4 S8 / S7 S1 S3 Mx7 S1 W / S4 S2 S2 S4 S8 S2",
          wins: [[1, 8, 0.4], [2, 8, 0.5]], removed: [1, 2, 6, 8, 9, 10, 14, 15, 16, 21, 23, 25, 26, 28, 29] },
        { t: 1, ts: "674a850e", st: "ebff4e8cbfbae814", hash: "208c42d1e5e3a03a",
          grid: "S4 S7 S1 S2 S1 S7 / S4 S2 S1 S3 S3 S5 / S4 W S4 S5 S5 S1 / S7 S3 S6 Mx7 S4 S2 / S4 S5 S3 S4 S8 S8",
          wins: [[4, 8, 0.7]], removed: [0, 1, 2, 4, 7, 12, 19, 23] },
        { t: 2, ts: "c2c9cfaa", st: "ce87a12ef231b2cf", hash: "21f5d79556e419d7",
          grid: "S5 S2 S8 S1 S3 S7 / S5 S7 S1 S2 S1 S5 / S1 S2 S1 S3 S3 S1 / S6 S3 S6 S5 S5 S2 / S7 S5 S3 Mx7 S8 S8",
          wins: [], removed: [] },
      ],
      tm: 11.2, currency: 2.24, M: 7,
    },
    {
      name: "V5", seed: "bd7c14095e8fc92a3c80212a1f0f8f7ac28bb0349c352c9156a6a24f0720db73",
      commit: "2cb17d5b7d6acd74d50d8f229417709f0e1fa0bf91062d3029ac93f84e68f6f7",
      client: "pf_scxjbJHFFF8jD", nonce: 0, round: 0, bonus: true, oi: 3332477434, oiHex: "c6a191fa",
      rounds: [
        { t: 0, ts: "71bbd322", st: "582f9a996d1090c2", hash: "35f9e5b3a0f4bf39",
          grid: "S3 S2 S2 S4 S4 S2 / S2 S1 S2 S1 S1 S2 / S9 S1 S6 S1 S8 S4 / S1 S2 S6 W S7 S4 / S1 S2 S2 S3 S2 S3",
          wins: [[1, 8, 0.4], [2, 11, 1.0]],
          removed: [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 16, 17, 18, 21, 24, 25, 26] },
        { t: 1, ts: "74688a8c", st: "49cdc19d21945e84", hash: "d9bcfa4980d87d30",
          grid: "S2 S2 S2 S2 S3 Mx3 / S4 S2 S2 S7 S5 S7 / S1 S1 S2 S4 S4 S4 / S3 S3 S6 S4 S8 S4 / S9 S6 S6 S3 S7 S3",
          wins: [], removed: [] },
      ],
      tm: 4.2, currency: 0.84, M: 3,
    },
  ];

  // §3.1: anywhere-pays clusters; returns [symbolNumber(1-based), count, paytable] sorted by symbol, and removed cells.
  function evaluate(grid: Cell[][]): { wins: Array<[number, number, number]>; removed: number[] } {
    const cells = grid.flat();
    const w = cells.filter((c) => c.sym === WILD).length;
    const wins: Array<[number, number, number]> = [];
    for (let s = 0; s < 9; s++) {
      const n = cells.filter((c) => c.sym === s).length;
      if (n >= 1 && n + w >= 8) wins.push([s + 1, n + w, PAY[s][Math.min(n + w, 12) - 8]]);
    }
    const removed: number[] = [];
    if (wins.length > 0) {
      const winSyms = new Set(wins.map((x) => x[0] - 1));
      cells.forEach((c, p) => { if (c.sym === WILD || winSyms.has(c.sym)) removed.push(p); });
    }
    return { wins, removed };
  }

  // §3.2 gravity + §2.4 refill: survivors settle to the bottom in order; emptied top cell p takes the fresh G_t[p].
  function tumble(grid: Cell[][], removed: number[], fresh: Cell[][]): Cell[][] {
    const gone = new Set(removed);
    return grid.map((column, col) => {
      const survivors = column.filter((_, row) => !gone.has(col * ROWS + row));
      const k = ROWS - survivors.length;
      return [...fresh[col].slice(0, k), ...survivors];
    });
  }

  function freshCells(grid: SymbolGrid, mults: Array<{ position: number; value: number }>): Cell[][] {
    const byPos = new Map(mults.map((m) => [m.position, m.value]));
    return grid.map((column, col) => column.map((sym, row) => ({ sym, mult: byPos.get(col * ROWS + row) ?? null })));
  }

  // ---- §2.2 worked example ----
  {
    const msg = Buffer.from("pf_jaTw5uQPC05yB", "utf8").toString("hex") + ":49";
    check("§2.2 V1 message text", msg === "70665f6a615477357551504330357942:49", msg);
    const d = createHmac("sha256", Buffer.from(VECTORS[0].seed, "hex")).update(msg).digest("hex");
    check("§2.2 V1 HMAC digest starts fe73754a", d.startsWith("fe73754a"), d.slice(0, 8));
  }

  // ---- §5 spin vectors ----
  for (const v of VECTORS) {
    const weights = v.bonus ? BONUS : BASE;
    check(`${v.name} commitment`, hashServerSeed(v.seed) === v.commit);
    const oi = computeOutcomeIndex(v.seed, v.client, v.nonce);
    check(`${v.name} outcome_index`, oi === v.oi && hex8(oi) === v.oiHex, `${oi} (${hex8(oi)})`);
    let current: Cell[][] | null = null;
    let C = 0;
    for (const r of v.rounds) {
      const ts = deriveTumbleSeed(oi, v.round, r.t);
      check(`${v.name} r${v.round} t${r.t} tumble_seed`, hex8(ts) === r.ts, hex8(ts));
      const st = new Pcg32(ts).state;
      check(`${v.name} r${v.round} t${r.t} state0`, hex16(st) === r.st, hex16(st));
      const th = createHash("sha256").update(`${oi}:${r.t}`, "ascii").digest("hex").slice(0, 16);
      check(`${v.name} t${r.t} tumble_hash (§2.3 cross-check)`, th === r.hash, th);
      const spin = reproduceSpin({
        serverSeed: v.seed, clientSeed: v.client, nonce: v.nonce, roundIndex: v.round, tumbleIndex: r.t,
        weightsPerReel: weights, multiplierSymbolIndex: v.bonus ? BONUS_MULT : null, multiplierValues: v.bonus ? MULT_LIST : null,
      });
      check(`${v.name} t${r.t} reproduceSpin oi/hex/seed`, spin.outcomeIndex === v.oi && spin.outcomeIndexHex === v.oiHex && spin.tumbleSeed === ts);
      const fresh = freshCells(spin.grid, spin.multipliers);
      const served = parseGrid(r.grid, v.bonus);
      current = current === null ? fresh : tumble(current, v.rounds[r.t - 1].removed, fresh);
      check(`${v.name} t${r.t} grid (30 cells, symbols + multiplier values) == served`, eq(current, served));
      const ev = evaluate(current);
      check(`${v.name} t${r.t} wins == stated`, eq(ev.wins, r.wins), JSON.stringify(ev.wins));
      check(`${v.name} t${r.t} removed == stated`, eq(ev.removed, r.removed));
      C += ev.wins.reduce((a, x) => a + x[2], 0);
    }
    const final = (current ?? []).flat();
    let tm: number;
    if (v.bonus) {
      const M = final.reduce((a, c) => a + (c.mult ?? 0), 0);
      check(`${v.name} final multiplier sum M`, M === v.M, String(M));
      tm = C > 0 && M > 0 ? C * M : C;
    } else {
      const scat = final.map((c, p) => (c.sym === BASE_BONUS ? p : -1)).filter((p) => p >= 0);
      const n = scat.length;
      const pay = n === 4 ? 3 : n === 5 ? 5 : n >= 6 ? 100 : 0;
      check(`${v.name} scatter pay`, pay === v.scatterPay, `${n} scatters, pay ${pay}`);
      if (v.scatters) check(`${v.name} scatter positions`, eq(scat, v.scatters), JSON.stringify(scat));
      const award = n >= 3 ? ({ 3: 8, 4: 10, 5: 12, 6: 14 } as Record<number, number>)[Math.min(n, 6)] : undefined;
      check(`${v.name} free spins awarded`, award === v.awarded, String(award));
      tm = C + pay;
    }
    check(`${v.name} total_multiplier`, Math.abs(tm - v.tm) < 1e-9, String(+tm.toFixed(10)));
    check(`${v.name} total_win_currency (stake 0.20)`, Math.abs(tm * 0.2 - v.currency) < 1e-9, String(+(tm * 0.2).toFixed(10)));
  }
  check("V1 total_win coins = round_0.01(1.1 x 0.199954) = 0.22", Math.round(1.1 * 0.199954 * 100) / 100 === 0.22);

  // ---- §5 generator vectors (first three outputs; (S+1)·M + 1 = state0 + 1) ----
  const M64 = 6364136223846793005n;
  const MASK = (1n << 64n) - 1n;
  const GEN: Array<[string, string, string, number[]]> = [
    ["V1 r0 t0", "c16f6d0c", "6d48b259ced08d46", [2904762124, 1640814390, 3813667684]],
    ["V1 r0 t1", "35d31d7d", "9f12b4a32bfcff10", [2839093011, 2525730931, 4018098244]],
    ["V1 r0 t2", "242ebed7", "f7b9a03f6285eca0", [2482252908, 2774677785, 3956507007]],
    ["V4 r5 t0", "5b743e8d", "e1efeec3058d51a3", [2477462755, 1680131858, 910088972]],
    ["V5 r0 t1", "74688a8c", "e0bf1f29f0dd8b13", [3843874110, 1373579023, 1769272822]],
    ["1968778 r3 t0", "14ec6dbd", "ecd9aa6a3bff2132", [2152404752, 2366013969, 483651028]],
  ];
  for (const [name, ts, S, outs] of GEN) {
    const p = new Pcg32(parseInt(ts, 16));
    const s0 = p.state;
    const got = [p.nextUint32(), p.nextUint32(), p.nextUint32()];
    check(`${name} first three outputs`, eq(got, outs), got.join(" "));
    const lhs = ((BigInt("0x" + S) + 1n) * M64 + 1n) & MASK;
    check(`${name} (S+1)*M+1 == state0+1 (§2.4a equivalence)`, lhs === ((s0 + 1n) & MASK));
  }
  check("1968778 state0 == 1812c3c0940022f7", hex16(new Pcg32(0x14ec6dbd).state) === "1812c3c0940022f7");
  {
    const p = new Pcg32(0x14ec6dbd);
    const g = generateGrid(p, BONUS);
    const m = generateMultipliers(g, p, BONUS_MULT, MULT_LIST);
    check("1968778 multipliers at 8,16,19,21 = 5,2,50,2", eq(m, [{ position: 8, value: 5 }, { position: 16, value: 2 }, { position: 19, value: 50 }, { position: 21, value: 2 }]), JSON.stringify(m));
    const p2 = new Pcg32(0x14ec6dbd);
    const g2 = generateGrid(p2, BONUS);
    const m2 = generateMultipliers(g2, p2, BONUS_MULT, MULT_VALUES, MULT_WEIGHTS);
    check("1968778 weighted path (values + weights) == list path", eq(m, m2));
  }
  {
    const p = new Pcg32(0x5b743e8d);
    generateGrid(p, BONUS);
    const o = p.nextUint32();
    check("V4 output 30 mod 200 == 157 -> value 7", o % 200 === 157 && MULT_LIST[157] === 7, String(o % 200));
  }
  {
    const p = new Pcg32(0x74688a8c);
    const g = generateGrid(p, BONUS);
    const m = generateMultipliers(g, p, BONUS_MULT, MULT_LIST);
    check("V5 t1 output 30 -> multiplier value 3", m.length === 1 && m[0].value === 3, JSON.stringify(m));
  }

  // ---- §2.4b draw rule and bias ----
  const TWO32 = 4294967296;
  const limitOf = (T: number): number => 0xffffffff - (0xffffffff % T);
  check("base reel 1 total == 545003", BASE[1].reduce((a, b) => a + b, 0) === 545003);
  check("bonus reel 1 total == 24177", BONUS[1].reduce((a, b) => a + b, 0) === 24177);
  check("multiplier list length == 200", MULT_LIST.length === 200);
  check("limit(545003) == 4294623640", limitOf(545003) === 4294623640);
  for (const T of [545003, 24177, 200, ...BASE.map((r) => r.reduce((a, b) => a + b, 0)), ...BONUS.map((r) => r.reduce((a, b) => a + b, 0))]) {
    const L = limitOf(T);
    // Kept range [0, L) is a whole number of copies of 0..T-1, so every residue is equally likely: bias 0.
    const ok = L % T === 0 && acceptedDraw(L - 1, T) === (L - 1) % T && acceptedDraw(L, T) === null && acceptedDraw(0xffffffff, T) === null && acceptedDraw(0, T) === 0;
    check(`bias report T=${T}: limit multiple of T, boundary accept/reject, discards ${TWO32 - L}`, ok);
  }
  const redraw = (T: number, sig: number): number => Number(((TWO32 - limitOf(T)) / TWO32).toPrecision(sig));
  check("redraw prob T=545003 ~ 8.0e-5", redraw(545003, 2) === 8.0e-5, String((TWO32 - limitOf(545003)) / TWO32));
  check("redraw prob T=24177 ~ 4.65e-6", redraw(24177, 3) === 4.65e-6, String((TWO32 - limitOf(24177)) / TWO32));
  check("redraw prob T=200 ~ 2.24e-8", redraw(200, 3) === 2.24e-8, String((TWO32 - limitOf(200)) / TWO32));
  for (const d of [4294666399, 4294760620, 4294909258]) {
    check(`§2.4b data draw ${d} is discarded on base reel 1`, acceptedDraw(d, 545003) === null);
  }
  {
    // Force a discard: for T > 2^31 the limit equals T, so with T = first output the first draw is discarded and
    // pickWeighted must take the second (needs a seed whose first output > 2^31 and second < first).
    let seed = 1;
    let outs: number[] = [];
    for (; seed < 1000; seed++) {
      const p = new Pcg32(seed);
      outs = [p.nextUint32(), p.nextUint32()];
      if (outs[0] > 2 ** 31 && outs[1] < outs[0]) break;
    }
    const T = outs[0];
    const q = new Pcg32(seed);
    const idx = pickWeighted(q, [outs[1] + 1, T - outs[1] - 1]); // index 0 iff kept draw <= outs[1]
    const r = new Pcg32(seed);
    r.nextUint32(); r.nextUint32();
    check(`pickWeighted redraws after a discard (seed ${seed}: draw 1 discarded, draw 2 kept, 2 draws consumed)`,
      limitOf(T) === T && acceptedDraw(outs[0], T) === null && idx === 0 && q.state === r.state);
  }
  {
    check("acceptedDraw T=3 boundary", acceptedDraw(0xffffffff, 3) === null && acceptedDraw(0xfffffffe, 3) === 0xfffffffe % 3);
    check("acceptedDraw T=1 discards only 2^32-1", acceptedDraw(0xfffffffe, 1) === 0 && acceptedDraw(0xffffffff, 1) === null);
  }

  // ---- ranges ----
  {
    const p = new Pcg32(0xdeadbeef);
    let ok = true;
    for (let i = 0; i < 100000; i++) {
      const u = p.nextUint32();
      if (!Number.isInteger(u) || u < 0 || u >= TWO32) { ok = false; break; }
    }
    check("nextUint32 in [0, 2^32) over 100000 draws", ok);
  }
  {
    const p = new Pcg32(12345);
    let ok = true;
    for (let i = 0; i < 2000; i++) {
      const g = generateGrid(p, i % 2 ? BONUS : BASE);
      const K = i % 2 ? 12 : 11;
      if (g.length !== REELS || g.some((c) => c.length !== ROWS || c.some((s) => !Number.isInteger(s) || s < 0 || s >= K))) { ok = false; break; }
    }
    check("generateGrid: 6x5, symbols in [0, K) over 2000 grids", ok);
  }
  {
    let ok = true;
    for (let i = 0; i < 2000; i++) {
      const oi = computeOutcomeIndex(createHash("sha256").update(String(i)).digest("hex"), `c${i}`, i);
      const ts = deriveTumbleSeed(oi, i % 7, i % 5);
      if (!Number.isInteger(oi) || oi < 0 || oi >= TWO32 || !Number.isInteger(ts) || ts < 0 || ts >= TWO32) { ok = false; break; }
    }
    check("outcome_index and tumble_seed in [0, 2^32) over 2000 inputs", ok);
  }
  {
    const p = new Pcg32(777);
    let ok = true;
    for (let i = 0; i < 20000; i++) {
      const T = 1 + (i * 7919) % 600000;
      const r = acceptedDraw(p.nextUint32(), T);
      if (r !== null && (r < 0 || r >= T)) { ok = false; break; }
    }
    check("acceptedDraw result in [0, T) or null over 20000 draws", ok);
  }

  // ---- hash check true / false, encoding ----
  check("hash check true: SHA-256(decoded V1 seed) == commitment", hashServerSeed(VECTORS[0].seed) === VECTORS[0].commit);
  check("hash check false: V2 seed vs V1 commitment", hashServerSeed(VECTORS[1].seed) !== VECTORS[0].commit);
  check("hash check false: one hex digit changed", hashServerSeed("0" + VECTORS[0].seed.slice(1)) !== VECTORS[0].commit);
  check("hash check false: SHA-256 over ASCII seed text != commitment", createHash("sha256").update(VECTORS[0].seed, "ascii").digest("hex") !== VECTORS[0].commit);
  check("upper-case seed gives same commitment and outcome_index",
    hashServerSeed(VECTORS[0].seed.toUpperCase()) === VECTORS[0].commit &&
    computeOutcomeIndex(VECTORS[0].seed.toUpperCase(), VECTORS[0].client, 49) === VECTORS[0].oi);
  check("round and tumble are not interchangeable (r1,t11) != (r11,t1)", deriveTumbleSeed(VECTORS[0].oi, 1, 11) !== deriveTumbleSeed(VECTORS[0].oi, 11, 1));
  let threw = false;
  try { hashServerSeed("xyz"); } catch { threw = true; }
  check("non-hex server seed is refused", threw);

  return { pass, total, failed };
}

describe('Spec self-test: src/rng.ts against docs/ALGORITHM.md (clean-room rebuild)', function () {
  this.timeout(300_000);
  it(`all ${EXPECTED_CHECKS} spec vector and property checks pass`, () => {
    const r = runSelftest();
    assert.deepStrictEqual(r.failed, []);
    assert.strictEqual(r.total, EXPECTED_CHECKS);
    assert.strictEqual(r.pass, EXPECTED_CHECKS);
  });
});
