#!/usr/bin/env bash
# Run a list of benchmark configs (one per line) N times, interleaved:
#   rep1: A B C ..., rep2: A B C ...  (so host-load drift hits every config alike)
#
#   ./run-matrix.sh <matrix-file> [reps] [out.jsonl]
#
# Matrix file: one config per line, "<label> <bench.mjs args...>", '#' = comment, e.g.
#   base-1080   --cpus 2 --viewport 1920x1080 --workload motion
#   jpeg-1080   --cpus 2 --viewport 1920x1080 --workload motion --env SELKIES_ENCODER=jpeg
# Env: PORT (default 4100), IMAGE (default potatos:bench), DUR (default 30)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MATRIX="$1"; REPS="${2:-1}"; OUT="${3:-${HERE}/results.jsonl}"
PORT="${PORT:-4100}"; DUR="${DUR:-30}"
mapfile -t LINES < <(grep -v -E '^\s*(#|$)' "${MATRIX}")
for rep in $(seq 1 "${REPS}"); do
  for line in "${LINES[@]}"; do
    label="${line%% *}"; args="${line#* }"
    # shellcheck disable=SC2086
    eval "set -- ${args}"
    echo "=== rep ${rep}: ${label}" >&2
    node "${HERE}/bench.mjs" --label "${label}" --port "${PORT}" --dur "${DUR}" --out "${OUT}" "$@" 2>>"${HERE}/bench.log" \
      || echo "!!! ${label} failed (see bench.log)" >&2
  done
done
