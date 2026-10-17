#!/usr/bin/env bash
# Push this package to the product repository.
# Default remote: https://github.com/Madmaxme/delivery-loop
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
REMOTE="${DELIVERY_LOOP_REMOTE:-Madmaxme/delivery-loop}"
git remote remove origin >/dev/null 2>&1 || true
git remote add origin "https://github.com/${REMOTE}.git"
git push -u origin main
echo "Pushed https://github.com/${REMOTE}"
