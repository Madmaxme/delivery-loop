#!/usr/bin/env bash
# Push this package to the product repository.
# DELIVERY_LOOP_REMOTE is owner/name. DELIVERY_LOOP_COMMIT_TOKEN is the push token.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
REMOTE="${DELIVERY_LOOP_REMOTE:-}"
if [[ -z "$REMOTE" ]]; then
  echo "DELIVERY_LOOP_REMOTE is required" >&2
  exit 1
fi
owner="${REMOTE%%/*}"
if [[ -n "${DELIVERY_LOOP_COMMIT_TOKEN:-}" ]]; then
  export GH_TOKEN="${DELIVERY_LOOP_COMMIT_TOKEN}"
fi
login="$(gh api user --jq .login 2>/dev/null || true)"
if [[ "$login" != "$owner" ]]; then
  echo "Refusing to push ${REMOTE}: token login is ${login:-not a user}, commit actor is ${owner}." >&2
  exit 1
fi
ask="$(mktemp)"
trap 'rm -f "$ask"' EXIT
cat >"$ask" <<'EOF'
#!/bin/sh
case "$1" in
  *sername*) printf '%s\n' 'x-access-token' ;;
  *) printf '%s\n' "$GH_TOKEN" ;;
esac
EOF
chmod 700 "$ask"
git remote remove origin >/dev/null 2>&1 || true
git remote add origin "https://github.com/${REMOTE}.git"
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_ASKPASS="$ask" GIT_TERMINAL_PROMPT=0 \
  git push -u origin main
echo "Pushed https://github.com/${REMOTE}"
