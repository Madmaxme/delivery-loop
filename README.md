# delivery-loop

Delivery Loop v2 is an agent-assisted delivery engine for Linear, GitHub, and Jira. Clients pin a package tag and provide project policy, acceptance criteria, and deployment commands in their own repository.

The v2 pack uses `schemaVersion: 2` and requires explicit eligibility, landing strategy, promotion stages, and completion status. The engine supports pull-request or fast-forward landing, runs ordered promotion stages, and records stage-verification receipts in tracker state. `audit` evaluates eligibility without delivery writes; `sweep` is an explicit serial run, not a scheduled job. See [METHODOLOGY.md](METHODOLOGY.md) for the index and [the master v2 procedure](conduct/methodology/SKILL.md) for behavior.

## Install

```bash
npm install -g github:<owner>/<repo>#vX.Y.Z
delivery-loop init --tracker github --eligibility none
delivery-loop update
```

`init` requires an explicit `--eligibility none` or `--eligibility command --eligibility-command <command>` choice; a bare `delivery-loop init` is invalid. For Jira, use `--tracker jira` and explicitly provide `--jira-api-base-url`, `--jira-auth-header-env`, `--jira-intake-jql`, and `--jira-approval-field-id`. The API URL must be HTTPS; credentials stay in the named environment variable.

`init` writes the v2 project pack and installs the canonical `.agents/skills/delivery-loop` and `.agents/skills/delivery-loop-conduct` skills. Cursor and Claude skill entries are symlinks to those canonical directories. `update` refreshes generated skills, the Cursor rule, and runner workflow without changing `delivery-loop.yaml` or the invariants file.

Use `delivery-loop audit` for a read-only eligibility review, `delivery-loop deliver <id>` for one ticket, and `delivery-loop sweep` for an explicitly dispatched intake run. `delivery-loop ship <id>` runs ship-authorized stages; `delivery-loop ship continue <id>` resumes the active ship stage. See the [v1-to-v2 migration guide](conduct/methodology/MIGRATION-V1-TO-V2.md) before upgrading a v1 client; v2 has no v1 pack or run-state compatibility path.

Optional run events are written by `scripts/run-event.sh` and posted only when `DELIVERY_LOOP_EVENT_URL` is set. Credential logs record the slot, endpoint class, and status, never tokens, headers, or request URLs.

Cursor credentials use `workerKeys.primary` and `workerKeys.fallback` (defaulting to `CURSOR_API_KEY` and `CURSOR_API_KEY_FALLBACK`); `workerModel` is optional. UI projects can configure `design.figmaTokenEnv`; the Figma token stays in the environment, not the pack.

Licensed under Apache-2.0. See `LICENSE`.

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

Clone this repo, branch from `main`, and open a pull request. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance. Adapter changes belong in `src/adapters` with tests. The versioned procedure and code-conduct sources are `conduct/methodology/SKILL.md` and `conduct/conduct/SKILL.md`; clients keep project-specific policy and deployment instructions in their overlays.
