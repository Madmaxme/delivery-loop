#!/usr/bin/env bash
# POST one worker-ledger row.
# Usage: ledger-report.sh <phase started|finished> <source engine-heal|ci|other> [status]
# Requires LEDGER_WEBHOOK_URL and LEDGER_WEBHOOK_AUTH (one HTTP header line).
# A missing secret or a failed POST prints ::error title=Ledger write failed:: and exits 1.
# The URL and the auth header are never printed.
set +x
set -euo pipefail
umask 077

fail() {
  local msg=$1
  msg=${msg//$'\n'/ }
  msg=${msg//$'\r'/ }
  msg=${msg//::/ }
  if ((${#msg} > 400)); then
    msg=${msg:0:400}
  fi
  printf '%s\n' "::error title=Ledger write failed::${msg}"
  exit 1
}

json_escape() {
  local s=$1 out="" i c o
  local LC_ALL=C
  for ((i = 0; i < ${#s}; i++)); do
    c=${s:i:1}
    case "$c" in
      \\) out+='\\' ;;
      '"') out+='\"' ;;
      $'\n') out+='\n' ;;
      $'\r') out+='\r' ;;
      $'\t') out+='\t' ;;
      *)
        printf -v o '%d' "'$c"
        if ((o < 32)); then
          printf -v out '%s\\u%04x' "$out" "$o"
        else
          out+=$c
        fi
        ;;
    esac
  done
  printf '%s' "$out"
}

# First string or number for key after marker. Works on pretty or one-line JSON.
event_field() {
  local file=$1 key=$2 marker=$3
  awk -v key="$key" -v marker="$marker" '
    {
      search_from = 1
      if (index($0, marker)) {
        seen = 1
        search_from = index($0, marker) + length(marker)
      } else if (!seen) {
        next
      }
      token = "\"" key "\""
      chunk = substr($0, search_from)
      n = index(chunk, token)
      if (n == 0) next
      rest = substr(chunk, n + length(token))
      sub(/^[[:space:]]*:[[:space:]]*/, "", rest)
      if (substr(rest, 1, 1) == "\"") {
        rest = substr(rest, 2)
        if (match(rest, /^[^"]*/)) print substr(rest, 1, RLENGTH)
      } else if (match(rest, /^[0-9]+/)) {
        print substr(rest, 1, RLENGTH)
      }
      exit
    }
  ' "$file"
}

phase=${1:-}
source=${2:-}
status=${3:-}

if [[ "$phase" != "started" && "$phase" != "finished" ]]; then
  fail "phase must be started or finished"
fi
if [[ "$source" != "engine-heal" && "$source" != "ci" && "$source" != "other" ]]; then
  fail "source must be engine-heal, ci, or other"
fi

url=${LEDGER_WEBHOOK_URL:-}
auth=${LEDGER_WEBHOOK_AUTH:-}
if [[ -z "$url" ]]; then
  fail "LEDGER_WEBHOOK_URL is empty"
fi
if [[ -z "$auth" ]]; then
  fail "LEDGER_WEBHOOK_AUTH is empty"
fi
case "$url" in
  http://*|https://*) ;;
  *) fail "LEDGER_WEBHOOK_URL is not an http(s) URL" ;;
esac
case "$url" in
  *\"*|*\'*|*$'\n'*|*$'\r'*|*[[:space:]]*) fail "LEDGER_WEBHOOK_URL is not a single URL" ;;
esac
if [[ "$auth" == *$'\n'* || "$auth" == *$'\r'* ]]; then
  fail "LEDGER_WEBHOOK_AUTH is not a single header line"
fi
if [[ ! "$auth" =~ ^[!#$%\&\'*+.^_\`\|~0-9A-Za-z-]+:[[:space:]]*[^[:space:]].*$ ]]; then
  fail "LEDGER_WEBHOOK_AUTH is not a single header line"
fi

repo=${GITHUB_REPOSITORY:-}
run_id=${GITHUB_RUN_ID:-}
run_attempt=${GITHUB_RUN_ATTEMPT:-}
server=${GITHUB_SERVER_URL:-}
workflow=${GITHUB_WORKFLOW:-}
event=${GITHUB_EVENT_NAME:-}
sha=${GITHUB_SHA:-}
if [[ -z "$repo" || -z "$run_id" || -z "$run_attempt" || -z "$server" ]]; then
  fail "GitHub run identity is empty"
fi

pr_number=""
event_file=${GITHUB_EVENT_PATH:-}
if [[ -n "$event_file" && -f "$event_file" ]]; then
  if command -v jq >/dev/null 2>&1; then
    inner=$(jq -r '.workflow_run.event // empty' "$event_file") || fail "could not read the GitHub event"
    pr=$(jq -r '.workflow_run.pull_requests[0].number // empty' "$event_file") || fail "could not read the GitHub event"
    head=$(jq -r '.workflow_run.head_sha // empty' "$event_file") || fail "could not read the GitHub event"
  else
    inner=$(event_field "$event_file" event '"workflow_run"')
    pr=$(event_field "$event_file" number '"pull_requests"')
    head=$(event_field "$event_file" head_sha '"workflow_run"')
  fi
  [[ -n "$inner" ]] && event=$inner
  [[ -n "$pr" && "$pr" != "null" ]] && pr_number=$pr
  [[ -n "$head" && "$head" != "null" ]] && sha=$head
fi

subject=$workflow
if [[ -n "$event" ]]; then
  subject="${subject} ${event}"
fi
if [[ "$source" == "engine-heal" && -n "$pr_number" ]]; then
  subject="${subject} #${pr_number}"
fi

key="gh:${repo}:run:${run_id}:${run_attempt}:${phase}"
link="${server}/${repo}/actions/runs/${run_id}"

tmp=$(mktemp -d) || fail "could not create a temp directory"
trap 'rm -rf "$tmp"' EXIT
body="$tmp/body.json"
hdr="$tmp/header"
cfg="$tmp/curl.cfg"
resp="$tmp/resp"
err="$tmp/err"
printf '%s\n' "$auth" >"$hdr"
printf 'url = "%s"\n' "$url" >"$cfg"

if command -v jq >/dev/null 2>&1; then
  jq -n -c \
    --arg key "$key" \
    --arg source "$source" \
    --arg repo "$repo" \
    --arg subject "$subject" \
    --arg link "$link" \
    --arg phase "$phase" \
    --arg status "$status" \
    --arg run_id "$run_id" \
    --arg run_attempt "$run_attempt" \
    --arg workflow "$workflow" \
    --arg sha "$sha" \
    '{key:$key,source:$source,repo:$repo,subject:$subject,link:$link,phase:$phase,status:$status,run_id:$run_id,run_attempt:$run_attempt,workflow:$workflow,sha:$sha}' \
    >"$body" || fail "could not build the ledger payload"
else
  {
    printf '{"key":"%s"' "$(json_escape "$key")"
    printf ',"source":"%s"' "$(json_escape "$source")"
    printf ',"repo":"%s"' "$(json_escape "$repo")"
    printf ',"subject":"%s"' "$(json_escape "$subject")"
    printf ',"link":"%s"' "$(json_escape "$link")"
    printf ',"phase":"%s"' "$(json_escape "$phase")"
    printf ',"status":"%s"' "$(json_escape "$status")"
    printf ',"run_id":"%s"' "$(json_escape "$run_id")"
    printf ',"run_attempt":"%s"' "$(json_escape "$run_attempt")"
    printf ',"workflow":"%s"' "$(json_escape "$workflow")"
    printf ',"sha":"%s"' "$(json_escape "$sha")"
    printf '}\n'
  } >"$body"
fi
[[ -s "$body" ]] || fail "could not build the ledger payload"

if ! command -v curl >/dev/null 2>&1; then
  fail "curl is missing"
fi

set +e
http=$(
  curl \
    --silent \
    --show-error \
    --fail-with-body \
    --retry 3 \
    --retry-all-errors \
    --max-time 20 \
    --request POST \
    --header @"$hdr" \
    --header "Content-Type: application/json" \
    --data-binary @"$body" \
    --output "$resp" \
    --write-out '%{http_code}' \
    --config "$cfg" \
    2>"$err"
)
code=$?
set -e
if [[ "$code" -ne 0 ]]; then
  http=${http//$'\n'/}
  if [[ "$http" =~ ^[0-9]+$ && ${#http} -ge 3 ]]; then
    http=${http: -3}
  fi
  if [[ "$http" =~ ^[1-9][0-9][0-9]$ ]]; then
    fail "POST failed after retries (HTTP ${http})"
  fi
  fail "POST failed after retries (curl exit ${code})"
fi
exit 0
