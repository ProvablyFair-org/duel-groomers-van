#!/usr/bin/env bash
# Build the GV CUDA enumerator. Regenerates the constants header from the
# operator config, then compiles cuda/gv_cuda.cu. Idempotent — safe to re-run.
set -euo pipefail

cd "$(dirname "$0")/.."   # → games/groomers-van

if ! command -v nvcc >/dev/null 2>&1; then
  echo "✗ nvcc not found. install CUDA toolkit (NVIDIA GPU required) or use 'npm run enumerate' (CPU path)."
  exit 1
fi

mkdir -p cuda outputs

# 1. Dump the GV constants from TS → JSON (single source of truth)
echo "→ dumping constants from operator config…"
npx ts-node src/dump-cuda-constants.ts > cuda/gv-constants.json

# 2. Generate the C++ header from the JSON
echo "→ generating C++ header…"
python3 cuda/gen_constants_h.py > cuda/gv_constants.h

# 3. Compile the kernel
echo "→ compiling gv_cuda.cu (arch=sm_89, optimized for Ada/Blackwell)…"
nvcc -O3 -std=c++17 -arch=sm_89 cuda/gv_cuda.cu -o cuda/gv_cuda
echo "✓ built cuda/gv_cuda"
