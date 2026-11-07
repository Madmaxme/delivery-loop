#!/usr/bin/env bash
# Write one delivery-loop run event as JSON.
# Usage: run-event.sh <phase started|finished> [status]
# The file is .delivery-loop/events/delivery-loop.run.<phase>.json under
# GITHUB_WORKSPACE, or the current directory when that variable is empty.
# A POST happens only when DELIVERY_LOOP_EVENT_URL is non-empty.
# DELIVERY_LOOP_EVENT_HEADER is an optional single header line.
# DELIVERY_LOOP_EVENT_REQUIRED (true or 1) makes a failed post fail the run.
# The default is to keep the run's own result. An empty URL does not post.
# The URL and the header are never printed.
set +x
set -euo pipefail
umask 077

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

read_head_sha() {
  local file=$1
  if [[ ! -f "$file" ]]; then
    return 0
  fi
  if command -v jq >/dev/null 2>&1; then
    jq -r '.workflow_run.head_sha // empty' "$file" 2>/dev/null || true
    return 0
  fi
  awk '
    {
      token = "\"head_sha\""
      n = index($0, token)
      if (n == 0) next
      rest = substr($0, n + length(token))
      sub(/^[[:space:]]*:[[:space:]]*/, "", rest)
      if (substr(rest, 1, 1) == "\"") {
        rest = substr(rest, 2)
        if (match(rest, /^[^"\\]*/)) print substr(rest, 1, RLENGTH)
      }
      exit
    }
  ' "$file"
}

phase=${1:-}
if [[ "$phase" != "started" && "$phase" != "finished" ]]; then
  printf '%s\n' "::error title=Run event::phase must be started or finished"
  exit 1
fi
status=${2:-}

repo=${GITHUB_REPOSITORY:-}
run_id=${GITHUB_RUN_ID:-}
run_attempt=${GITHUB_RUN_ATTEMPT:-}
server=${GITHUB_SERVER_URL:-}
workflow=${GITHUB_WORKFLOW:-}
sha=${GITHUB_SHA:-}
event_path=${GITHUB_EVENT_PATH:-}
if [[ -n "$event_path" ]]; then
  head=$(read_head_sha "$event_path" || true)
  if [[ -n "$head" && "$head" != "null" ]]; then
    sha=$head
  fi
fi
if [[ -z "$repo" || -z "$run_id" || -z "$run_attempt" || -z "$server" || -z "$sha" ]]; then
  printf '%s\n' "::error title=Run event::run identity is empty"
  exit 1
fi

id="gh:${run_id}:${run_attempt}:${phase}"
source="${server}/${repo}"
type="delivery-loop.run.${phase}"
stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

root=${GITHUB_WORKSPACE:-.}
out_dir="${root}/.delivery-loop/events"
mkdir -p "$out_dir"
event_file="${out_dir}/${type}.json"

if command -v jq >/dev/null 2>&1; then
  jq -n -c \
    --arg specversion "1.0" \
    --arg id "$id" \
    --arg source "$source" \
    --arg type "$type" \
    --arg time "$stamp" \
    --arg repo "$repo" \
    --arg sha "$sha" \
    --arg workflow "$workflow" \
    --arg run_id "$run_id" \
    --arg run_attempt "$run_attempt" \
    --arg phase "$phase" \
    --arg status "$status" \
    '{specversion:$specversion,id:$id,source:$source,type:$type,time:$time,data:{repo:$repo,sha:$sha,workflow:$workflow,run_id:$run_id,run_attempt:$run_attempt,phase:$phase,status:$status}}' \
    >"$event_file"
else
  {
    printf '{'
    printf '"specversion":"1.0"'
    printf ',"id":"%s"' "$(json_escape "$id")"
    printf ',"source":"%s"' "$(json_escape "$source")"
    printf ',"type":"%s"' "$(json_escape "$type")"
    printf ',"time":"%s"' "$(json_escape "$stamp")"
    printf ',"data":{'
    printf '"repo":"%s"' "$(json_escape "$repo")"
    printf ',"sha":"%s"' "$(json_escape "$sha")"
    printf ',"workflow":"%s"' "$(json_escape "$workflow")"
    printf ',"run_id":"%s"' "$(json_escape "$run_id")"
    printf ',"run_attempt":"%s"' "$(json_escape "$run_attempt")"
    printf ',"phase":"%s"' "$(json_escape "$phase")"
    printf ',"status":"%s"' "$(json_escape "$status")"
    printf '}}\n'
  } >"$event_file"
fi
[[ -s "$event_file" ]] || {
  printf '%s\n' "::error title=Run event::could not write the run event"
  exit 1
}

url=${DELIVERY_LOOP_EVENT_URL:-}
header=${DELIVERY_LOOP_EVENT_HEADER:-}
if [[ -z "$url" ]]; then
  exit 0
fi

required=0
case "${DELIVERY_LOOP_EVENT_REQUIRED:-}" in
  1|true|TRUE|True|yes|YES) required=1 ;;
esac

http_code=""
post_failed=0

post_event() {
  case "$url" in
    http://*|https://*) ;;
    *) return 1 ;;
  esac
  case "$url" in
    *\\*|*\"*|*\'*|*$'\n'*|*$'\r'*|*[[:space:]]*) return 1 ;;
  esac
  if [[ -n "$header" ]]; then
    if [[ "$header" == *$'\n'* || "$header" == *$'\r'* ]]; then
      return 1
    fi
    if [[ ! "$header" =~ ^[!#$%\&\'*+.^_\`\|~0-9A-Za-z-]+:[[:space:]]*[^[:space:]].*$ ]]; then
      return 1
    fi
  fi
  if ! command -v curl >/dev/null 2>&1; then
    return 1
  fi
  local tmp hdr cfg resp err http code
  tmp=$(mktemp -d) || return 1
  hdr="$tmp/header"
  cfg="$tmp/curl.cfg"
  resp="$tmp/resp"
  err="$tmp/err"
  if [[ -n "$header" ]]; then
    printf '%s\n' "$header" >"$hdr" || {
      rm -rf "$tmp"
      return 1
    }
  fi
  printf 'url = "%s"\n' "$url" >"$cfg" || {
    rm -rf "$tmp"
    return 1
  }
  local -a args
  args=(
    --silent
    --show-error
    --fail-with-body
    --globoff
    --proto '=http,https'
    --retry 1
    --retry-all-errors
    --retry-delay 1
    --max-time 20
    --request POST
    --header "Content-Type: application/json"
  )
  if [[ -n "$header" ]]; then
    args+=(--header "@${hdr}")
  fi
  args+=(
    --data-binary "@${event_file}"
    --output "$resp"
    --write-out '%{http_code}'
    --config "$cfg"
  )
  set +e
  http=$(curl "${args[@]}" 2>"$err")
  code=$?
  set -e
  rm -rf "$tmp"
  if [[ "$code" -ne 0 ]]; then
    http=${http//$'\n'/}
    if [[ "$http" =~ ^[0-9]+$ && ${#http} -ge 3 ]]; then
      http=${http: -3}
    fi
    if [[ "$http" =~ ^[1-9][0-9][0-9]$ ]]; then
      http_code=$http
    fi
    return 1
  fi
  return 0
}

if ! post_event; then
  post_failed=1
fi

if [[ "$post_failed" -eq 0 ]]; then
  exit 0
fi

msg="post failed"
if [[ -n "$http_code" ]]; then
  msg="post failed (HTTP ${http_code})"
fi
if [[ "$required" -eq 1 ]]; then
  printf '%s\n' "::error title=Run event::${msg}"
  exit 1
fi
printf '%s\n' "::warning title=Run event::${msg}"
exit 0
