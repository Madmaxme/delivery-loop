# Methodology

The versioned master procedure is [the Delivery Loop v2 skill](conduct/methodology/SKILL.md). Its companion code-conduct source is [conduct/conduct/SKILL.md](conduct/conduct/SKILL.md). [AGENTS.md](AGENTS.md) and [.cursor/rules](.cursor/rules) point agents to these canonical sources. Clients pin a package tag and keep eligibility, Jira policy, acceptance meaning, deployment commands, and environment instructions in their own overlays.

`delivery-loop init` writes a complete v2 pack and installs the canonical skills under `.agents/skills`; Cursor and Claude skill entries link to those targets. `delivery-loop update` refreshes generated skills, the Cursor rule, and runner workflow without changing the pack or invariants.

Before upgrading a v1 client, follow the [v1-to-v2 migration guide](conduct/methodology/MIGRATION-V1-TO-V2.md). V2 has no v1 pack or run-state compatibility path.

## Roles

The orchestrator talks to the owner; the engineering bot runs explicit audit, deliver, sweep, and ship commands. Delivery and ship promotion stages execute in configured order, with receipts bound to the exact landed SHAs and acceptance criteria. Clients provide deployment policy in their overlays. GitHub records pull requests, checks, and merges.

## Merge

Any actor may squash-merge an ordinary pull request once quality is green on the head. Engine-heal pull requests are merged by their workflow. A branch that is only behind is updated from trunk, then quality runs again on the new head. Two updates are the limit. When the install lists `commitActors` for that repo, the token's login is that actor.

Check-runs use the token printed by `DELIVERY_LOOP_GITHUB_MINT` when that command is set. Other forge calls keep the forge token. A bare token expires 60 minutes after the mint. JSON with `token` and `expires_at` uses that expiry. The forge mints again when five minutes or less remain. A 401 or 403 from check-runs is a credential error. The forge does not read that check from another endpoint.

When `DELIVERY_LOOP_GITHUB_MINT` is set, each run mints once at startup and reads `/rate_limit` with that token. Later check-runs reuse it. A failed mint or rate-limit read is logged and the run continues. That read is not a check.

A Figma frame URL is the `figma.com` address. Surrounding markdown and a trailing `)` `]` `>` `.` `,` `;` or quote are not part of it. `node-id=1-2` is read as `1:2`. A 400 includes Figma's `err` or `message` and stops as a rejected request. A 403 or 404 stops as access and names `design.figmaTokenEnv`. The token, the headers, and a URL that contains a token are not written.

## Credential log

Each credential call writes one line. The line names the slot, the endpoint class, and the status. A success is included. A mint writes `slot=mint` and `endpoint=mint`. A re-mint near expiry adds `refresh=1`. Check-runs write `endpoint=check-runs`, with `slot=mint` when the mint command is set and `slot=gh-token` when it is not. Other GitHub calls write `slot=gh-token` and a class such as `pulls`, `contents`, `commits`, `compare`, `actions`, `issues`, `git`, or `user`. Linear writes `slot=linear` and `endpoint=linear-graphql`. A cursor launch writes `slot=primary` or `slot=fallback` and `endpoint=cursor-launch`. An http worker start writes `endpoint=worker-http-start`. An http worker status read writes `endpoint=worker-http-status`. A status-store seed writes `endpoint=worker-http-seed`. The slot is `worker-http`, or `mint` or `gh-token` when a header or the forge credential uses that source. A Figma read writes `slot=figma` and `endpoint=figma`.

The run line is `[delivery-loop] credential slot=<slot> endpoint=<endpoint> status=<status>`. The run ends with one summary line per slot, endpoint class, and status: `[delivery-loop] credential summary slot=<slot> endpoint=<endpoint> status=<status> count=<n>`. A grep for `credential summary` that finds no status other than 200 means every recorded call returned 200.

```text
[delivery-loop] credential slot=mint endpoint=mint status=200
[delivery-loop] credential slot=mint endpoint=mint status=200 refresh=1
[delivery-loop] credential slot=mint endpoint=check-runs status=200
[delivery-loop] credential slot=gh-token endpoint=pulls status=200
[delivery-loop] credential summary slot=mint endpoint=check-runs status=200 count=1
[delivery-loop] credential summary slot=mint endpoint=mint status=200 count=2
[delivery-loop] credential summary slot=gh-token endpoint=pulls status=200 count=1
```

The token, the headers, and the request URL are not written. A slot or endpoint class outside the known set is logged as `unknown`. A usable mint is logged as `status=200`. A mint that exits 0 without a usable token logs `status=0`. A worker launch that succeeds logs `status=200`. A launch that fails without an HTTP status logs `status=0`. A GraphQL error carried on HTTP 200 stays `status=200`. A stage promotion skipped because its configured refs already contain the commit does not add a promotion-success line. Success messages name the result, never the command.

A validated journey proof writes `[delivery-loop] proof ok`. A successful stage promotion writes `[delivery-loop] promote ok`; a passing stage receipt writes `[delivery-loop] verify ok`. A squash that returns a commit writes `[delivery-loop] land ok`.

## Engine heal

An engine heal opens a pull request on `engine-heal/<ticket>` with the `engine-heal` label. Routine heals use the next patch after the highest `v*` tag; `engineHealBumpVersion` remains patch-only. The planned v2.0.0 release is an explicitly authorized greater-version bump over main's current package version, not output from the routine helper. The opener commits both package version files and pushes with the commit-actor token. The `pull_request` `quality` check gates the head. Only the engine-heal workflow squash-merges and writes the tag and GitHub release; no manual tag or release is created. Clients pin the resulting tag.

A missing recorded journey proof after landing blocks completion. The evidence must come from the original build receipt or a client-owned verifier; a later run does not start a generic worker to capture it. Validated v2 `DeliveryState` `proof-receipt` markers remain reusable only for the current criteria revision and exact landed SHAs. Jira comments remain for user-visible blockers or Product decisions only.

## Run events

A worker run may write `delivery-loop.run.started` and `delivery-loop.run.finished`. The writer is `scripts/run-event.sh`. The schema is [schemas/run-event-1.0.schema.json](schemas/run-event-1.0.schema.json). The script writes `.delivery-loop/events/<type>.json` and the workflow uploads the artifact `delivery-loop-run-events`. This package does not post the file. A client sets `DELIVERY_LOOP_EVENT_URL` to an http(s) endpoint and may set `DELIVERY_LOOP_EVENT_HEADER`. An empty URL only writes the file. A failed post leaves the run's own exit code. `DELIVERY_LOOP_EVENT_REQUIRED` set to `true` or `1` makes a failed post fail the run. The URL and the header are never printed.

## Lease

One runner holds the ticket with a `delivery-lease` marker in `DeliveryState`. The marker records the live agent id as soon as the worker starts.

## Bot definitions

A leftover `bots` key is ignored with a warning.

## Ship outcomes

Promotion stages run in configured order. A stage applies to the intersection of its repos and the ticket's landed repos. An empty intersection is recorded as not-applicable: the stage command does not run, and the outcome is not passed and not blocked. When every stage in that authorization has an empty intersection, the run fails closed. Delivery stages run during `deliver` and `sweep`; ship-authorized stages run only through explicit `ship` commands after delivery completion and current delivery receipts. A stage verifier must return a complete receipt for the exact target, that stage's landed SHAs, criteria revision, and the criteria that apply to that stage. An acceptance criterion may name stages or repos. An empty cell applies it to every stage, or to every repo that stage landed. A receipt does not reuse evidence from another stage. The authorization is complete when every applicable stage has passed and every criterion that applies there has verified evidence on a passed receipt. The package entry exports `validateStageReceipt`, `StageVerifyInput`, and `StageVerificationReceipt` so a verifier can check that receipt before printing it. The engine removes credential environment names before promote, verify, and continue. The deployment names that command is allowed to receive stay. A verifier obtains any other credential inside its own command, for example by exchanging a workload identity with a secret store. The engine does not pass a removed credential value into the verifier. `verify.timeoutMs`, `promote.timeoutMs`, and `continue.timeoutMs` are optional. The named command stops when that many milliseconds pass, and the stage is blocked. An omitted timeout does not impose one and does not copy another command's value. A parked ship stage exits 0 only when `parkSuccess` is true; otherwise it exits 2 and never writes `status.shipped`. Blocked stages fail. Exit 75 or a non-zero result with `delivery-loop transient <reason>` retries a stage's promote, verify, or continue command. `transient.maxAttempts` defaults to 3, waits start at one second and double, and `transient.maxWaitMs` defaults to 60000 and caps the total wait. Exhausting that budget reports the stage failure to the regular heal flow.

## Worker keys

The cursor worker launches with the env var named by `workerKeys.primary`, then the env var named by `workerKeys.fallback`. The defaults are `CURSOR_API_KEY` and `CURSOR_API_KEY_FALLBACK`. The log records the slot in use, `primary` or `fallback`, and the launch status. A launch that succeeds logs `status=200`. A launch that fails without an HTTP status logs `status=0`. The value stays in the environment.

A capacity or balance refusal on the primary slot retries that launch once on the fallback slot.
An authentication failure stops on the slot that returned it.
A rate limit stops on the slot that returned it.
A network failure stops on the slot that returned it.
A refusal from both slots fails the launch and reports that both slots are out of capacity.
An empty fallback variable leaves that launch on the primary slot.

`workerModel` is the cursor model id. The launch passes `{ id }` and the credential line names that id. An absent `workerModel` omits the model and logs that the account default is in use.
A 5xx on a cursor launch waits one second and retries that slot once. A second 5xx uses the fallback slot. Each attempt logs its slot, `endpoint=cursor-launch`, and status.

## HTTP worker

`worker: http` posts a start request to `workerHttp.startUrl`, then reads until the result is terminal. The loop generates the request id and sends it on start. Without `statusStore`, it reads `workerHttp.statusUrl`. With `statusStore`, the loop writes a pending file through the forge before start, using the minted token or the forge token, and creates `branch` from the default branch when it is missing. Status reads then come from that file, so each read is a 200 file read. A non-2xx seed fails the worker and does not start. The seed logs `endpoint=worker-http-seed`. When `request` is set, start does not post `startUrl`. After the seed it opens one forge issue titled `worker-request <id>`, then assigns `assignee` in a second call. The issue body is a fenced JSON block of the start record plus `requestedBy`, the login recorded for the forge credential. When that block is longer than 65536 characters, the full record is written beside the pending file at `<path-without-json>.request.json` and the issue body is only that path. A non-2xx issue create or assign fails the worker and does not start another launcher. Those calls log `endpoint=worker-request-issue` and `endpoint=worker-request-assign`. A non-2xx `startUrl` post fails that worker the same way.

`workerHttp.pollMs` defaults to 15000. `workerHttp.maxWaitMs` defaults to 3600000. Join sleeps `pollMs` between reads. `pending` and `running` are not terminal. `finished` and `failed` are terminal. When `maxWaitMs` passes, the result is failed and the detail is `http worker join exceeded maxWaitMs`. `maxWaitMs` is at least `pollMs` and no greater than the hosted job budget of 360 minutes.

`workerHttp.startHeaders` and `workerHttp.statusHeaders` map a header name to an env var name. The names `mint` and `gh-token` are the minted installation token and the forge token. `mint` uses the forge token when `DELIVERY_LOOP_GITHUB_MINT` is unset. An `Authorization` value with no scheme is sent as a bearer token. The value is not written. `WORKER_HTTP_TOKEN` is the Authorization value when the maps omit it.

`workerModel` is sent as `model: { id }` on start, the same shape as a cursor launch. An absent `workerModel` omits `model`. The prompt is the one the engine already builds.

A status URL body with `encoding` of `base64` and `content`, and no `status`, is decoded and read as the result. A forge file read returns the record itself.

When `statusStore` is set, the start body adds the resolved file:

```json
"statusStore": { "repo": "<owner/name>", "branch": "<branch>", "path": "<resolved-path>" }
```

The loop writes this record before that POST:

```json
{
  "status": "pending",
  "id": "<request-id>",
  "repoUrl": "<repo-url>",
  "baseRef": "<base-ref>",
  "requestedAt": "<iso-time>"
}
```

The relay updates that same file. `pending` and `running` stay open. `finished` and `failed` stop the wait. `branch`, `head`, `branches`, and `text` are the same fields as a status URL response.

Start request:

```json
{
  "id": "<request-id>",
  "prompt": "<prompt>",
  "repoUrl": "<repo-url>",
  "baseRef": "<base-ref>",
  "model": { "id": "<workerModel>" },
  "statusStore": { "repo": "<owner/name>", "branch": "<branch>", "path": "worker-results/<request-id>.json" }
}
```

`statusStore` is present only when `statusUrl` mode is used and that key is set, or when the same record is placed on a forge issue. `path` is the template with `{id}` replaced. `requestedBy` is added on the issue record. Any 2xx `startUrl` response is success. The body is ignored.

Forge issue body, when it fits:

````markdown
```json
{"id":"<request-id>","prompt":"<prompt>","repoUrl":"<repo-url>","baseRef":"<base-ref>","model":{"id":"<workerModel>"},"statusStore":{"repo":"<owner/name>","branch":"<branch>","path":"worker-results/<request-id>.json"},"requestedBy":"<login>"}
```
````

When the fenced block is longer than 65536 characters, the issue body is `worker-results/<request-id>.request.json` and that file holds the same JSON.

`statusUrl` replaces `{id}` with the request id. A URL with no `{id}` gains the id as its last path segment. A query string needs `{id}`.

Status response, HTTP 200:

```json
{
  "status": "pending",
  "branch": "<branch>",
  "head": "<sha>",
  "branches": [{ "repoUrl": "<repo-url>", "branch": "<branch>" }],
  "text": "<text>"
}
```

`branch`, `head`, and `branches` may be absent until `finished`. `text` may be empty. A non-2xx status read fails the worker.

```yaml
worker: http
workerModel: <model-id>
workerHttp:
  startUrl: https://<host>/start
  statusUrl: https://<host>/status/{id}
  pollMs: 15000
  maxWaitMs: 3600000
  startHeaders:
    Authorization: <start-token-env>
  statusHeaders:
    Authorization: mint
  statusStore:
    kind: forge
    repo: <owner/name>
    branch: <branch>
    path: worker-results/{id}.json
  request:
    kind: forge-issue
    repo: <owner/name>
    assignee: <login>
    labels:
      - <label>
```

`request` replaces `startUrl` and requires `statusStore`. `labels` may be omitted.

`statusUrl` is the read path when `statusStore` is absent. `statusStore` replaces those reads. `path` must contain `{id}`. The start body sends that path with the id filled in.
