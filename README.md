# delivery-loop

Versioned autonomous delivery loop. Four things are required. The vendor behind each one is an adapter.

1. **Git** holds the code, the branch, and the merge. `forge: github` opens a pull request. `forge: git` merges with git on any remote.
2. **A work queue** is a shared list of what is next, what is blocked, and what is done. `tracker: linear` or `tracker: github`. Files in the repo are not a queue.
3. **A runner** executes commands with nobody sitting there. `runner: gha` is GitHub Actions. `runner: local` is this process. One of them is required.
4. **A coding worker** edits the code. The runner starts it and waits. `worker` is `cursor`, `claude`, `codex`, `copilot`, or `http`.

`check: workflow` polls the named quality workflow on the github forge. `check: command` runs `qualityCommand` in the checkout. A workflow check requires `forge: github`.

The orchestrator talks to the owner. The engineering bot owns the code and runs the loop: it dispatches sweeps, launches cloud agents, and merges, or leaves the merge to the lander or the engine-heal workflow. Any actor may squash-merge once quality is green on the head. A branch that is only behind is updated from trunk, then quality runs again on the new head. GitHub is the record.

An install keeps its own `delivery-loop.yaml` and invariants file. This repository does not name those projects. [METHODOLOGY.md](METHODOLOGY.md) is the index. [conduct/methodology/SKILL.md](conduct/methodology/SKILL.md) is the master copy, versioned by git tags. Clients pin a tag and add overlays.

Licensed under Apache-2.0. See `LICENSE`.

```bash
npm install -g github:<owner>/<repo>#vX.Y.Z
delivery-loop init
delivery-loop connector add sentry
delivery-loop update
```

`init` and `update` replace installed skills, the Cursor rule, and the runner workflow. They leave `delivery-loop.yaml` and the invariants file alone. The runner clones the pinned tag over HTTPS and installs dependencies in that checkout before the global install, because `npm install -g <dir>` only symlinks the directory.

`scripts/bootstrap-remote.sh` pushes `main` to `DELIVERY_LOOP_REMOTE` when the token's `GET /user` login is that remote's owner. An install names the same rule with `commitActors`: a write to a listed repo uses a token whose login is the actor.

## Run events

A worker run may write `delivery-loop.run.started` and `delivery-loop.run.finished` as JSON files and upload them as a workflow artifact. The writer is `scripts/run-event.sh`. This repository does not post those files. A client posts one by setting `DELIVERY_LOOP_EVENT_URL`. The field contract is in [METHODOLOGY.md](METHODOLOGY.md). A failed post leaves the run's own exit code unless `DELIVERY_LOOP_EVENT_REQUIRED` is `true` or `1`.

## Credential log

Each credential call writes one `[delivery-loop] credential` line with the slot, the endpoint class, and the status. Success is included. A re-mint near expiry adds `refresh=1`. The run ends with `[delivery-loop] credential summary` lines of counts by slot, endpoint class, and status. The field contract and the limits are in [METHODOLOGY.md](METHODOLOGY.md). The token, the headers, and the request URL are not written.

A recorded proof that passes writes `[delivery-loop] proof ok`. A promote or ship command that exits 0 writes `[delivery-loop] promote ok` or `[delivery-loop] ship ok`. A squash that returns a commit writes `[delivery-loop] land ok`.

## Bot definitions

A leftover `bots` key is ignored with a warning.

## Worker keys

The cursor worker launches with the env var named by `workerKeys.primary`, then the env var named by `workerKeys.fallback`. The defaults are `CURSOR_API_KEY` and `CURSOR_API_KEY_FALLBACK`. The log records the slot in use, `primary` or `fallback`, and the launch status. A launch that succeeds logs `status=200`. A launch that fails without an HTTP status logs `status=0`. The value stays in the environment.

```yaml
workerKeys:
  primary: <primary-env>
  fallback: <fallback-env>
```

A capacity or balance refusal on the primary slot retries that launch once on the fallback slot.
An authentication failure stops on the slot that returned it.
A rate limit stops on the slot that returned it.
A network failure stops on the slot that returned it.
A refusal from both slots fails the launch and reports that both slots are out of capacity.
An empty fallback variable leaves that launch on the primary slot.

A zero ship exit with no outcome lines is success, including a store wait. The pack prints `delivery-loop outcome <ticket> COMPLETE`, `PARKED`, or `BLOCKED`, and an optional reason. Exit 0 means every ticket is COMPLETE. Exit 2 means a PARKED ticket and no BLOCKED ticket, unless `ship.parkSuccess` is true. Any BLOCKED line exits 1. `ship.parkSuccess` defaults to false. Exit 75, or a non-zero exit plus `delivery-loop transient <reason>`, retries that ship or promote step. `transient.maxAttempts` defaults to 3. Waits start at one second and double. `transient.maxWaitMs` defaults to 60000 and caps the sum. A spent budget reports the reason and does not edit an owner.

```yaml
transient:
  maxAttempts: 3
  maxWaitMs: 60000
ship:
  parkSuccess: false
```

`workerModel` is the cursor model id. The launch passes `{ id }` and the credential line names that id. An absent `workerModel` omits the model and logs that the account default is in use.

```yaml
workerModel: <model-id>
```

A 5xx on a cursor launch waits one second and retries that slot once. A second 5xx uses the fallback slot. Each attempt logs its slot, `endpoint=cursor-launch`, and status.

## HTTP worker

`worker: http` posts the start request below to `workerHttp.startUrl`. The loop generates `id`. Without `statusStore`, it reads `workerHttp.statusUrl`. With `statusStore`, the loop writes a pending file through the forge before start and reads the same file afterward. The credential is the minted token, or the forge token when the mint command is unset. A missing `branch` is created from the default branch. A non-2xx seed fails the worker and does not start. `request` replaces `startUrl`: after the seed the loop opens one forge issue, then assigns it. A non-2xx issue create or assign fails the worker and does not start another launcher. A non-2xx `startUrl` post fails the same way.

`pollMs` defaults to 15000. `maxWaitMs` defaults to 3600000 and stays inside the hosted job budget of 360 minutes. Join sleeps `pollMs` between reads. `pending` and `running` stay open. `finished` and `failed` stop the wait. A spent `maxWaitMs` is a failed worker, detail `http worker join exceeded maxWaitMs`.

Header maps name an env var, or `mint` or `gh-token`. `mint` is the minted installation token. `gh-token` is the forge token. No secret is stored in the pack. An http start logs `endpoint=worker-http-start`. A status read logs `endpoint=worker-http-status`. A seed logs `endpoint=worker-http-seed`. An issue create logs `endpoint=worker-request-issue`. An assign logs `endpoint=worker-request-assign`. The request URL and the header values are not written.

`model` is `{ id }` from `workerModel`. An absent `workerModel` omits it. A status URL body that is a base64 document (`encoding` of `base64` and `content`) is decoded as the result. A forge file read is the record itself.

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

`request` replaces `startUrl` and requires `statusStore`. The issue title is `worker-request <id>`. The body is a fenced JSON block of the start record plus `requestedBy`. When that block is longer than 65536 characters, the full JSON is written at `worker-results/<id>.request.json` and the issue body is only that path.

`statusUrl` stays the read path when `statusStore` is absent. `path` must contain `{id}`. The start body sends `statusStore` with that path filled in. The file written before the POST is `{"status":"pending","id","repoUrl","baseRef","requestedAt"}`. The relay updates that file. `pending` and `running` stay open. `finished` and `failed` stop the wait.

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

`statusStore` is present only when that key is set. `path` is the template with `{id}` replaced. Any 2xx is success. The body is ignored. `statusUrl` replaces `{id}`. Without `{id}`, the id is the last path segment. A query string needs `{id}`.

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

## Contribute

Clone this repo, branch from `main`, and open a pull request. The `quality` workflow runs the tests. Titles and bodies are in [CONTRIBUTING.md](CONTRIBUTING.md).

A new tracker, forge, or worker is a file in `src/adapters` plus a test. Trackers implement `listIntake`, `get`, `comment`, and `setState`. Workers implement `start` and `join`. Forges implement `openPullRequest`, `quality`, `mergeability`, `compare`, `updateBranch`, and `squashMerge`. `squashMerge` returns the merge commit.

An install keeps its repos, trunk branches, status names, and promote commands in its own `delivery-loop.yaml`.

The runner prepends `conduct/conduct/SKILL.md` to every ground and build prompt. That file is the universal law: one code path, evidence before building, a work order that cites an invariant which already exists, a green quality check, `**Prior request:**`, `**Outside grant:**`, and `**Journey evidence:**`. A recorded journey marks dev-done with proof: an https recording or screenshot URL in the build receipt, or a route test on the merged commit whose path matches `journeySpec`. When that commit does not contain the route test, a resume checks the promoted dev ref and records the journey command token. A spec outside that pattern is not proof. An install's prompt files and invariants file hold the concrete proof.

A rule about how any ticket moves belongs in this repository. An install's product names, repos, and proof belong in that install. `status.hold` is the install's name for the status that does not clear blockers after owned code lands and the grant is still outside the repo. The default is `Hold`. `status.dev` and `status.prod` stay the done states.

`design` names UI repos. When a ticket has a `figma.com` frame in the description, a comment, or a tracker attachment, the work order includes `**Design source:**` with that URL. The runner reads the frame from the Figma REST API using the env var named by `design.figmaTokenEnv`. The package does not ship a token. When a frame is present and that variable is empty, the runner stops with `missing-credential: figma`. A frame URL is the `figma.com` address. Surrounding markdown and a trailing `)` `]` `>` `.` `,` `;` or quote are not part of it. `node-id=1-2` is read as `1:2`. A 400 includes Figma's `err` or `message` and stops as a rejected request. A 403 or 404 stops as access and names `design.figmaTokenEnv`. Token and secret values are never printed or stored. When the ticket has no frame and a land repo is listed under `design.repos`, Validation includes that repo's `check` command. After the pull request opens, the runner reads the check run named `checkName` on that pull request's head sha. That read uses the token printed by `DELIVERY_LOOP_GITHUB_MINT` when the command is set, and mints again when five minutes or less remain. When that command is set, each run mints once at startup and reads `/rate_limit` with that token. A failed mint or rate-limit read is logged and the run continues. A 401 or 403 from check-runs is a credential error. The runner does not read the check from another endpoint. A result recorded on a different sha is ignored. A missing or red check is a quality failure and uses the same heal cap.

```yaml
design:
  figmaTokenEnv: <token-env>
  repos:
    - name: <repo>
      check: <check-command>
      checkName: <check-name>
      tokenFile: <path>
```

`prompts.ground` and `prompts.build` are workspace-relative files the runner puts in the worker prompt after that law. `invariantHeadings` lists heading files that count as invariant ids beside `invariantsFile`. A heading in a file with `prefix` becomes the id `<prefix>/<slug>`.

```yaml
prompts:
  ground:
    - <ground-file>
  build:
    - <build-file>
invariantHeadings:
  - prefix: <prefix>
    file: <headings-file>
```
