#!/usr/bin/env bash
# Run the GV CUDA enumerator over the full 2^32 PCG32 output space for both
# base and bonus modes. Writes outputs/{base,bonus}-2pow32.json + sha256.
#
# Total wall time: ~70s on an RTX 5060. ~30s on H100-class hardware.
#
# Re-build first if the binary doesn't exist or the source is newer.
set -euo pipefail

cd "$(dirname "$0")/.."   # → games/groomers-van

if [ ! -x cuda/gv_cuda ] || [ cuda/gv_cuda.cu -nt cuda/gv_cuda ]; then
  bash scripts/build-cuda.sh
fi

mkdir -p outputs

echo "→ enumerating base game (4.29B spins on GPU)…"
./cuda/gv_cuda --from 0 --to 4294967296 --condition base --out outputs/base-2pow32.json

echo "→ enumerating bonus game (4.29B spins on GPU)…"
./cuda/gv_cuda --from 0 --to 4294967296 --condition bonus --out outputs/bonus-2pow32.json

echo ""
echo "✓ done. artifacts:"
sha256sum outputs/base-2pow32.json outputs/bonus-2pow32.json

echo ""
echo "next: 'npm run session-ev' to compute E[bonus-buy session]"
