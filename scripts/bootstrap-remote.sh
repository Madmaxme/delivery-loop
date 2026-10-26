#!/usr/bin/env bash
# Push this package to the product repository.
# Default remote: https://github.com/Madmaxme/delivery-loop
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
REMOTE="${DELIVERY_LOOP_REMOTE:-Madmaxme/delivery-loop}"
owner="${REMOTE%%/*}"
login="$(gh api user --jq .login)"
if [[ "$login" != "$owner" ]]; then
  echo "Refusing to push ${REMOTE}: token login is ${login:-not a user}, commit actor is ${owner}." >&2
  exit 1
fi
git remote remove origin >/dev/null 2>&1 || true
git remote add origin "https://github.com/${REMOTE}.git"
git push -u origin main
echo "Pushed https://github.com/${REMOTE}"
