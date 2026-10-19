// Groomer's Van — CUDA exhaustive enumerator.
//
// Each thread = one outcome_index in [from, to). Computes the resulting
// spin payout under base_game or bonus_game and writes it to out_payouts[tid].
// Host aggregates: histogram + sum + win count + max.
//
// Build:
//   nvcc -O3 -std=c++17 -arch=sm_89 gv_cuda.cu -o gv_cuda
//
// (sm_89 is Ada/RTX 40 — Blackwell sm_120 needs CUDA 12.8+, this rig has 12.0
//  so we compile for sm_89 PTX and let the driver JIT to actual sm_120.)
//
// Usage:
//   ./gv_cuda --from 0 --to 1000000 --condition base
//   ./gv_cuda --from 0 --to 4294967296 --condition bonus

#include "gv_constants.h"

#include <cuda_runtime.h>
#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <chrono>
#include <algorithm>

// ────────────────────────────────────────────────────────────────────────────
// PCG32 RNG + tumble-seed mix (bit-parity with rng.ts)
// ────────────────────────────────────────────────────────────────────────────

__device__ __forceinline__ uint64_t pcg32_init(uint32_t seed32) {
    uint64_t s = (uint64_t)seed32;
    s = s + 0x9e3779b97f4a7c15ULL;
    s = (s ^ (s >> 30)) * 0xbf58476d1ce4e5b9ULL;
    s = (s ^ (s >> 27)) * 0x94d049bb133111ebULL;
    s ^= (s >> 31);
    return s;
}

__device__ __forceinline__ uint32_t pcg32_next(uint64_t* state) {
    uint64_t old = *state;
    *state = old * 6364136223846793005ULL + 0x5851f42d4c957f2dULL;
    uint32_t xs  = (uint32_t)(((old >> 18) ^ old) >> 27);
    uint32_t rot = (uint32_t)(old >> 59) & 31u;
    return (xs >> rot) | (xs << ((32u - rot) & 31u));
}

__device__ __forceinline__ uint32_t derive_tumble_seed(uint32_t outcome, uint32_t round_idx, uint32_t tumble) {
    uint32_t x = outcome;
    x ^= (round_idx + 1u) * 0x9e3779b9u;
    x ^= (tumble + 1u)    * 0x85ebca6bu;
    x ^= x >> 16;
    x *= 0xc2b2ae35u;
    x ^= x >> 16;
    return x;
}

// Rejection-sampled weighted pick from cumulative-weight array.
// Returns symbol index in [0, n).
__device__ __forceinline__ uint32_t pick_weighted(uint64_t* state, const uint32_t* cum, uint32_t total, int n) {
    const uint32_t MAX_U32 = 0xFFFFFFFFu;
    uint32_t max_fair = MAX_U32 - (MAX_U32 % total);
    uint32_t rnd;
    do { rnd = pcg32_next(state); } while (rnd >= max_fair);
    uint32_t pick = rnd % total;
    for (int i = 0; i < n; i++) {
        if (pick < cum[i]) return (uint32_t)i;
    }
    return (uint32_t)(n - 1);  // unreachable for well-formed cum
}

// ────────────────────────────────────────────────────────────────────────────
// Base-game spin payout — outcome_index → payout (capped at MAX_WIN_X)
// ────────────────────────────────────────────────────────────────────────────

__device__ double spin_base(uint32_t outcome_index, int* final_scatters) {
    constexpr int N = BASE_N_SYMBOLS;
    constexpr int W_IDX = BASE_WILD_IDX;
    constexpr int B_IDX = BASE_BONUS_IDX;

    uint8_t grid[N_REELS][N_ROWS];
    double total_base_mult = 0.0;
    int cumulative_scatters = 0;

    // Cascade 0: initial deal
    uint32_t tseed = derive_tumble_seed(outcome_index, 0u, 0u);
    uint64_t prng  = pcg32_init(tseed);
    for (int c = 0; c < N_REELS; c++) {
        for (int r = 0; r < N_ROWS; r++) {
            grid[c][r] = (uint8_t)pick_weighted(&prng, BASE_CUM_WEIGHTS[c], BASE_REEL_TOTAL[c], N);
        }
    }

    // Initial scatter count
    for (int c = 0; c < N_REELS; c++) for (int r = 0; r < N_ROWS; r++)
        if (grid[c][r] == B_IDX) cumulative_scatters++;

    // Cascade loop (max 30 — safety cap)
    for (int casc = 0; casc < 30; casc++) {
        // Count wilds + per-symbol cells
        int wild_count = 0;
        int sym_count[N] = {0};
        for (int c = 0; c < N_REELS; c++) for (int r = 0; r < N_ROWS; r++) {
            uint8_t s = grid[c][r];
            if (s == W_IDX) wild_count++;
            else if (s != B_IDX) sym_count[s]++;
        }

        // Resolve clusters: for each payable symbol with size >= 8
        bool any_win = false;
        bool removed[N_REELS][N_ROWS] = {{false}};
        for (int s = 0; s < N; s++) {
            if (s == W_IDX || s == B_IDX) continue;
            int cluster_size = sym_count[s] + wild_count;
            if (cluster_size < MIN_CLUSTER_SIZE) continue;
            int tier = cluster_size >= 12 ? 4 : (cluster_size - 8);
            double m = BASE_PAYOUTS[s][tier];
            if (m <= 0.0) continue;
            total_base_mult += m;
            any_win = true;
            // Mark cells of this symbol + wilds as removed
            for (int c = 0; c < N_REELS; c++) for (int r = 0; r < N_ROWS; r++) {
                uint8_t cell = grid[c][r];
                if (cell == (uint8_t)s || cell == W_IDX) removed[c][r] = true;
            }
        }

        if (!any_win) break;

        // Next cascade: fresh tumble_seed → fresh PCG → fresh grid → top-fill
        tseed = derive_tumble_seed(outcome_index, 0u, (uint32_t)(casc + 1));
        prng = pcg32_init(tseed);
        uint8_t newg[N_REELS][N_ROWS];
        for (int c = 0; c < N_REELS; c++) {
            for (int r = 0; r < N_ROWS; r++) {
                newg[c][r] = (uint8_t)pick_weighted(&prng, BASE_CUM_WEIGHTS[c], BASE_REEL_TOTAL[c], N);
            }
        }
        // Gravity: survivors fall, top-fill from newg top-down
        for (int c = 0; c < N_REELS; c++) {
            uint8_t surv[N_ROWS];
            int sn = 0;
            for (int r = 0; r < N_ROWS; r++) if (!removed[c][r]) surv[sn++] = grid[c][r];
            int empty = N_ROWS - sn;
            for (int r = 0; r < empty; r++) grid[c][r] = newg[c][r];
            for (int r = 0; r < sn; r++)    grid[c][empty + r] = surv[r];
        }

        // Recount scatters after gravity
        cumulative_scatters = 0;
        for (int c = 0; c < N_REELS; c++) for (int r = 0; r < N_ROWS; r++)
            if (grid[c][r] == B_IDX) cumulative_scatters++;
    }

    // Scatter pay (base only, 3+ scatters)
    double scatter_pay = 0.0;
    if (cumulative_scatters >= 3) {
        int tier = cumulative_scatters >= 6 ? 6 : cumulative_scatters;
        scatter_pay = BASE_SCATTER_PAY[tier];
    }

    double payout = total_base_mult + scatter_pay;
    if (payout > MAX_WIN_X) payout = MAX_WIN_X;
    *final_scatters = cumulative_scatters;
    return payout;
}

// ────────────────────────────────────────────────────────────────────────────
// Bonus-game spin payout — outcome_index → payout (capped at MAX_WIN_X)
// Multiplier values drawn from the same PCG stream after the grid per cascade.
// Bombs accumulate across all cascades and apply ONCE at end of spin.
// ────────────────────────────────────────────────────────────────────────────

__device__ double spin_bonus(uint32_t outcome_index, int* final_scatters) {
    constexpr int N = BONUS_N_SYMBOLS;
    constexpr int W_IDX = BONUS_WILD_IDX;
    constexpr int B_IDX = BONUS_BONUS_IDX;
    constexpr int M_IDX = BONUS_MULT_IDX;

    uint8_t grid[N_REELS][N_ROWS];
    double total_base_mult = 0.0;
    int cumulative_bombs  = 0;
    int cumulative_scatters = 0;

    uint32_t tseed = derive_tumble_seed(outcome_index, 0u, 0u);
    uint64_t prng  = pcg32_init(tseed);
    for (int c = 0; c < N_REELS; c++) {
        for (int r = 0; r < N_ROWS; r++) {
            grid[c][r] = (uint8_t)pick_weighted(&prng, BONUS_CUM_WEIGHTS[c], BONUS_REEL_TOTAL[c], N);
        }
    }

    // Initial multiplier draws — for every cell where symbol == M_IDX,
    // draw one weighted value from MULT_VALUES.
    for (int c = 0; c < N_REELS; c++) for (int r = 0; r < N_ROWS; r++) {
        if (grid[c][r] == M_IDX) {
            uint32_t idx = pick_weighted(&prng, MULT_CUM_WEIGHTS, MULT_TOTAL, N_MULT_VALUES);
            cumulative_bombs += (int)MULT_VALUES[idx];
        }
    }

    for (int c = 0; c < N_REELS; c++) for (int r = 0; r < N_ROWS; r++)
        if (grid[c][r] == B_IDX) cumulative_scatters++;

    // Cascade loop
    for (int casc = 0; casc < 30; casc++) {
        int wild_count = 0;
        int sym_count[N] = {0};
        for (int c = 0; c < N_REELS; c++) for (int r = 0; r < N_ROWS; r++) {
            uint8_t s = grid[c][r];
            if (s == W_IDX) wild_count++;
            else if (s != B_IDX && s != M_IDX) sym_count[s]++;
        }

        bool any_win = false;
        bool removed[N_REELS][N_ROWS] = {{false}};
        for (int s = 0; s < N; s++) {
            if (s == W_IDX || s == B_IDX || s == M_IDX) continue;
            int cluster_size = sym_count[s] + wild_count;
            if (cluster_size < MIN_CLUSTER_SIZE) continue;
            int tier = cluster_size >= 12 ? 4 : (cluster_size - 8);
            double m = BONUS_PAYOUTS[s][tier];
            if (m <= 0.0) continue;
            total_base_mult += m;
            any_win = true;
            for (int c = 0; c < N_REELS; c++) for (int r = 0; r < N_ROWS; r++) {
                uint8_t cell = grid[c][r];
                if (cell == (uint8_t)s || cell == W_IDX) removed[c][r] = true;
            }
        }

        if (!any_win) break;

        // Next cascade
        tseed = derive_tumble_seed(outcome_index, 0u, (uint32_t)(casc + 1));
        prng = pcg32_init(tseed);
        uint8_t newg[N_REELS][N_ROWS];
        for (int c = 0; c < N_REELS; c++) {
            for (int r = 0; r < N_ROWS; r++) {
                newg[c][r] = (uint8_t)pick_weighted(&prng, BONUS_CUM_WEIGHTS[c], BONUS_REEL_TOTAL[c], N);
            }
        }
        // Multiplier value draws for ALL multiplier symbols in newg (same PCG32
        // stream consumption, matching the operator's spec). BUT only those
        // landing on top-filled positions after gravity actually contribute
        // bombs — the rest are draws for cells that don't survive to the
        // playing grid. We store (position, value) and filter post-gravity.
        struct NewMult { int pos; int value; };
        NewMult newg_mults[N_REELS * N_ROWS];
        int n_newg_mults = 0;
        for (int c = 0; c < N_REELS; c++) for (int r = 0; r < N_ROWS; r++) {
            if (newg[c][r] == M_IDX) {
                uint32_t idx = pick_weighted(&prng, MULT_CUM_WEIGHTS, MULT_TOTAL, N_MULT_VALUES);
                newg_mults[n_newg_mults].pos = c * N_ROWS + r;
                newg_mults[n_newg_mults].value = (int)MULT_VALUES[idx];
                n_newg_mults++;
            }
        }
        // Gravity + record which positions were filled from newg (top of each col)
        bool is_filled_new[N_REELS][N_ROWS] = {{false}};
        for (int c = 0; c < N_REELS; c++) {
            uint8_t surv[N_ROWS];
            int sn = 0;
            for (int r = 0; r < N_ROWS; r++) if (!removed[c][r]) surv[sn++] = grid[c][r];
            int empty = N_ROWS - sn;
            for (int r = 0; r < empty; r++) {
                grid[c][r] = newg[c][r];
                is_filled_new[c][r] = true;
            }
            for (int r = 0; r < sn; r++) grid[c][empty + r] = surv[r];
        }
        // Add only the multipliers that landed on top-filled positions
        for (int k = 0; k < n_newg_mults; k++) {
            int pos = newg_mults[k].pos;
            int c = pos / N_ROWS;
            int r = pos - c * N_ROWS;
            if (is_filled_new[c][r]) cumulative_bombs += newg_mults[k].value;
        }
        cumulative_scatters = 0;
        for (int c = 0; c < N_REELS; c++) for (int r = 0; r < N_ROWS; r++)
            if (grid[c][r] == B_IDX) cumulative_scatters++;
    }

    int bomb_mult = cumulative_bombs > 1 ? cumulative_bombs : 1;
    double payout = total_base_mult * (double)bomb_mult;
    if (payout > MAX_WIN_X) payout = MAX_WIN_X;
    *final_scatters = cumulative_scatters;
    return payout;
}

// ────────────────────────────────────────────────────────────────────────────
// Kernels
// ────────────────────────────────────────────────────────────────────────────

__global__ void enumerate_base_kernel(uint32_t from, uint32_t count, double* out, uint8_t* out_scatters) {
    uint32_t tid = blockIdx.x * blockDim.x + threadIdx.x;
    if (tid >= count) return;
    int sc = 0;
    out[tid] = spin_base(from + tid, &sc);
    out_scatters[tid] = (uint8_t)(sc > 255 ? 255 : sc);
}

__global__ void enumerate_bonus_kernel(uint32_t from, uint32_t count, double* out, uint8_t* out_scatters) {
    uint32_t tid = blockIdx.x * blockDim.x + threadIdx.x;
    if (tid >= count) return;
    int sc = 0;
    out[tid] = spin_bonus(from + tid, &sc);
    out_scatters[tid] = (uint8_t)(sc > 255 ? 255 : sc);
}

// ────────────────────────────────────────────────────────────────────────────
// Host main
// ────────────────────────────────────────────────────────────────────────────

#define CK(x) do { cudaError_t e = (x); if (e) { fprintf(stderr, "CUDA error at %s:%d: %s\n", __FILE__, __LINE__, cudaGetErrorString(e)); exit(1); } } while(0)

int main(int argc, char** argv) {
    uint64_t from = 0, to = 1000000;
    bool bonus = false;
    bool dump_per_thread = false;
    const char* out_path = nullptr;

    for (int i = 1; i < argc; i++) {
        if      (!strcmp(argv[i], "--from"))      from = strtoull(argv[++i], nullptr, 10);
        else if (!strcmp(argv[i], "--to"))        to   = strtoull(argv[++i], nullptr, 10);
        else if (!strcmp(argv[i], "--condition")) bonus = !strcmp(argv[++i], "bonus");
        else if (!strcmp(argv[i], "--dump"))      dump_per_thread = true;
        else if (!strcmp(argv[i], "--out"))       out_path = argv[++i];
    }

    uint64_t count = to - from;
    fprintf(stderr, "cuda enumerate: from=%llu to=%llu count=%llu condition=%s\n",
            (unsigned long long)from, (unsigned long long)to, (unsigned long long)count, bonus ? "bonus" : "base");

    // Device info
    int dev; cudaGetDevice(&dev);
    cudaDeviceProp prop; cudaGetDeviceProperties(&prop, dev);
    fprintf(stderr, "device: %s, SM %d.%d, %d SMs, %zu MiB total\n",
            prop.name, prop.major, prop.minor, prop.multiProcessorCount, prop.totalGlobalMem >> 20);

    constexpr uint32_t BATCH = 1u << 22;  // 4M threads per batch — uses 16 MB per batch
    double*  d_out; CK(cudaMalloc(&d_out, BATCH * sizeof(double)));
    double*  h_out = (double*)malloc(BATCH * sizeof(double));
    uint8_t* d_scatters = nullptr;
    uint8_t* h_scatters = nullptr;
    // both base + bonus track scatters now (base for game-RTP integration)
    CK(cudaMalloc(&d_scatters, BATCH * sizeof(uint8_t)));
    h_scatters = (uint8_t*)malloc(BATCH * sizeof(uint8_t));

    double sum = 0.0;
    uint64_t wins = 0, total_done = 0;
    double max_payout = 0.0;
    // Histogram bucketed at 0.01 stake granularity, 0..5000 → 500,001 buckets
    constexpr int HIST_BUCKETS = 500001;
    uint64_t* histogram = (uint64_t*)calloc(HIST_BUCKETS, sizeof(uint64_t));
    // Scatter-count histogram (bonus only): 0..7+ → 8 buckets
    uint64_t scatter_hist[8] = {0};
    // Joint (payout_int, scatter_count) sparse histogram — only built if bonus
    // For storage: row-major, but most cells are zero so we accumulate per-batch
    // and only emit non-zero entries. Use a 2D dense uint64 array.
    uint64_t (*joint_hist)[8] = (uint64_t(*)[8])calloc(HIST_BUCKETS * 8, sizeof(uint64_t));

    auto t0 = std::chrono::steady_clock::now();

    for (uint64_t start = from; start < to; start += BATCH) {
        uint32_t this_batch = (uint32_t)std::min((uint64_t)BATCH, to - start);
        int block_size = 256;
        int grid_size  = (this_batch + block_size - 1) / block_size;
        if (bonus) enumerate_bonus_kernel<<<grid_size, block_size>>>((uint32_t)start, this_batch, d_out, d_scatters);
        else       enumerate_base_kernel <<<grid_size, block_size>>>((uint32_t)start, this_batch, d_out, d_scatters);
        CK(cudaGetLastError());
        CK(cudaMemcpy(h_out, d_out, this_batch * sizeof(double), cudaMemcpyDeviceToHost));
        CK(cudaMemcpy(h_scatters, d_scatters, this_batch * sizeof(uint8_t), cudaMemcpyDeviceToHost));

        for (uint32_t i = 0; i < this_batch; i++) {
            double p = h_out[i];
            sum += p;
            if (p > 0.0) wins++;
            if (p > max_payout) max_payout = p;
            int b = (int)(p * 100.0 + 0.5);
            if (b < 0) b = 0;
            if (b >= HIST_BUCKETS) b = HIST_BUCKETS - 1;
            histogram[b]++;
            int sc = (int)h_scatters[i];
            int sb = sc >= 7 ? 7 : sc;
            scatter_hist[sb]++;
            joint_hist[b][sb]++;
            if (dump_per_thread) printf("%u %.6f\n", (uint32_t)(start + i), p);
        }
        total_done += this_batch;

        auto t = std::chrono::steady_clock::now();
        double elapsed = std::chrono::duration<double>(t - t0).count();
        double rate = total_done / elapsed;
        double pct = 100.0 * total_done / count;
        double eta = (count - total_done) / rate;
        fprintf(stderr, "  done=%llu (%.2f%%) rate=%.0fK/s elapsed=%.1fs eta=%.1fs rtp=%.6f\n",
                (unsigned long long)total_done, pct, rate / 1000.0, elapsed, eta, sum / total_done);
    }

    auto t1 = std::chrono::steady_clock::now();
    double elapsed = std::chrono::duration<double>(t1 - t0).count();
    double rate = count / elapsed;

    fprintf(stderr, "\ndone: spins=%llu elapsed=%.2fs rate=%.0fK/s\n",
            (unsigned long long)count, elapsed, rate / 1000.0);
    fprintf(stderr, "  RTP = %.8f\n", sum / count);
    fprintf(stderr, "  win rate = %.6f (%llu / %llu)\n", (double)wins / count, (unsigned long long)wins, (unsigned long long)count);
    fprintf(stderr, "  max payout = %.4f\n", max_payout);

    // Write JSON artifact if requested
    if (out_path) {
        FILE* f = fopen(out_path, "w");
        if (!f) { fprintf(stderr, "failed to open %s for write\n", out_path); exit(1); }
        fprintf(f, "{\n");
        fprintf(f, "  \"range\": {\"from\": %llu, \"to\": %llu, \"count\": %llu},\n",
                (unsigned long long)from, (unsigned long long)to, (unsigned long long)count);
        fprintf(f, "  \"condition\": \"%s\",\n", bonus ? "bonus_game" : "base_game");
        fprintf(f, "  \"sum\": %.17g,\n", sum);
        fprintf(f, "  \"wins\": %llu,\n", (unsigned long long)wins);
        fprintf(f, "  \"max_payout\": %.17g,\n", max_payout);
        fprintf(f, "  \"rtp\": %.17g,\n", sum / count);
        fprintf(f, "  \"win_rate\": %.17g,\n", (double)wins / count);
        fprintf(f, "  \"elapsed_sec\": %.6f,\n", elapsed);
        fprintf(f, "  \"hist_granularity\": 0.01,\n");
        fprintf(f, "  \"histogram\": [");
        bool first = true;
        for (int b = 0; b < HIST_BUCKETS; b++) {
            if (histogram[b] == 0) continue;
            if (!first) fprintf(f, ",");
            fprintf(f, "[%d,%llu]", b, (unsigned long long)histogram[b]);
            first = false;
        }
        fprintf(f, "],\n  \"scatter_histogram\": [");
        for (int s = 0; s < 8; s++) {
            if (s) fprintf(f, ",");
            fprintf(f, "%llu", (unsigned long long)scatter_hist[s]);
        }
        fprintf(f, "],\n  \"joint_histogram\": [");
        first = true;
        for (int b = 0; b < HIST_BUCKETS; b++) {
            for (int s = 0; s < 8; s++) {
                if (joint_hist[b][s] == 0) continue;
                if (!first) fprintf(f, ",");
                fprintf(f, "[%d,%d,%llu]", b, s, (unsigned long long)joint_hist[b][s]);
                first = false;
            }
        }
        fprintf(f, "]\n}\n");
        fclose(f);
        fprintf(stderr, "wrote %s\n", out_path);
    }

    free(histogram);
    if (joint_hist) free(joint_hist);
    if (h_scatters) free(h_scatters);
    if (d_scatters) cudaFree(d_scatters);
    cudaFree(d_out);
    free(h_out);
    return 0;
}
