#!/usr/bin/env bash
# Create the private product repo and push main.
# The GitHub organization delivery-loop must already exist.
# Requires a user token that can create private repositories in that org.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ORG="${DELIVERY_LOOP_ORG:-delivery-loop}"
REPO="${DELIVERY_LOOP_REPO:-delivery-loop}"
if ! gh api "orgs/${ORG}" --jq .login >/dev/null; then
  echo "Organization ${ORG} does not exist. Create it at https://github.com/organizations/plan then re-run." >&2
  exit 1
fi
if ! gh repo view "${ORG}/${REPO}" >/dev/null 2>&1; then
  gh repo create "${ORG}/${REPO}" --private --description "Autonomous ticket loop" --disable-wiki --disable-issues
fi
git remote remove origin >/dev/null 2>&1 || true
git remote add origin "https://github.com/${ORG}/${REPO}.git"
git push -u origin main
echo "Pushed https://github.com/${ORG}/${REPO}"
