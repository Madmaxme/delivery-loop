---
name: methodology
description: Master copy of the delivery-loop harness. Ticket flow, status writes, locking, merge, promote, and self-heal. Clients pin a git tag and add overlays. Conduct stays in the conduct skill.
---

# Delivery loop

This file is the master copy of the harness methodology. Git tags version it. A client pins a tag and keeps product names, repos, and proof in its own repo. This file names no client.

The orchestrator talks to the owner. The engineering bot owns the code and runs the loop: it dispatches sweeps, launches cloud agents, and merges, or leaves the merge to the lander or the engine-heal workflow. GitHub is the record.

Code conduct is [conduct/conduct/SKILL.md](../conduct/SKILL.md). The runner prepends that file to every ground and build prompt. Conduct stays in that skill.

The engine is the only status writer. Ground and build prompts leave tracker calls to the engine.

## From intake to dev

1. Sweep lists tickets in `status.intake`. The default name is Todo.
2. A ticket runs when every `blockedBy` link is in `status.dev`, `status.prod`, or `status.closed`. The defaults are Dev, Prod, Canceled, and Duplicate. A self-link is not ready.
3. One runner holds a ticket. The hold is a `DELIVERY_LEASE` comment with a two-hour expiry. The lease records the live agent id as soon as the worker starts. Sweep skips a live lease. Deliver waits. A dead Actions run can be taken. A live run is taken only after expiry.
4. Ground reads the code and returns a verdict. It does not edit. A verdict other than BUILDABLE is parked or left in intake. See the status table.
5. Build runs only when the handoff has a work order, an invariant that already exists, `**Prior request:**`, `**Outside grant:**`, and `**Journey evidence:**`. `**Repos:**` names land repos from the pack. The checkout directory is not a land repo unless it is on that list.
6. Land opens one pull request per repo, in pack order. A branch identical to trunk, or with no commits of its own, is not opened. The next sweep leaves that ticket alone while that commit is still the tip.
7. The pull request merges only when quality is green and the forge reports the branch clean. Every open pull request on the ticket is ready before the first squash. One that is not ready leaves the others unmerged. Any actor may squash-merge that head. Quality is the `quality` workflow, or `qualityCommand` when `check` is `command`. A branch that is only behind is updated from trunk, then quality runs again on the new head. Two updates are the limit. A conflict or a refused merge is a heal. The engine does not rebase.
8. A later sweep resumes a ticket that already has pull requests on its land repos. The branch name is the install template. A merged pull request counts as landed. An open one uses the same quality and merge path, including the ready-before-squash rule. The engine does not start from ground while those pull requests are the land. A repo named in the recorded work order that has no pull request, and is not already on trunk, stays on the ground path.
9. The merge is a squash. Quality then runs on the trunk tip that contains the merge. A later green commit on that trunk counts. A red or pending tip stays in intake. The runner does not start a coding worker from trunk.
10. When the trunk check is green, `dev.promote` runs its command once for each landed repo that is also listed in `dev.promote.repos`, including a repo whose pull request merged before this sweep. `{repo}` is replaced. When `dev.promote.refs` names the deploy branches that command moves, the engine skips the command for a repo whose refs already contain the landed commit. When `refs` is absent, the command runs. When `promote` is set, `dev.steps` are not run. Otherwise `dev.steps` run. This same promote runs before `status.dev` when the verdict is ALREADY SHIPPED and the named commits are on trunk.
11. The ticket moves to `status.dev`, or to `status.hold` when `**Outside grant:**` is open. Before the `status.dev` write, the engine posts one comment with the validated proof receipt, the merged SHA, and the pull request URL, and a resume reuses that comment. Hold does not clear blockers. The default hold name is Hold. A ticket already in `status.dev` or `status.prod`, whose pull requests are merged and whose named deploy refs contain those commits, is left as it is.
12. Journey evidence `recorded` marks dev-done only with proof. A web journey needs an https recording or screenshot URL in the build receipt. A mobile journey needs the route test on the merged commit, and that path matches `journeySpec`. A spec outside that pattern leaves the ticket in intake. Before the dev status, a resume uses that check. When the merged commit does not contain the route test, the resume checks the promoted dev ref: `dev.promote.refs` for that repo when they are set, otherwise the repo trunk. A journey command token that is present there is recorded. Recorded evidence that already satisfies that check is kept. The proof comment is posted once and reused. A journey command that prints no token names the command, the ticket, and the expected token. The ticket stays in intake until that token is present.
13. `ship` is a separate command. It takes a ticket id and sets `DELIVERY_LOOP_SHIP_ARGS` to `--issue <id>`, then any extra arguments, before the ship steps run. `ship.afterDev` runs those steps after the dev gate and passes that same `--issue <id>`. A command without a ticket id stops before the steps run. A failed ship step leaves the dev status. `ship.markStatus: false` does not move the ticket to prod. Store continue is `ship continue` and takes the same ticket id.

When a ticket lands or a verdict moves it, the same sweep reads the queue again so a ticket that was waiting on it can run. The runner writes one line when a ticket enters ground, build, or land, and one line when it finishes.

## Statuses the engine writes

| When | Status |
| --- | --- |
| Sweep intake | reads `status.intake` (default Todo). It does not move a ticket there. |
| WRONG DIAGNOSIS | Canceled |
| NEEDS RESCOPE after a cited harness packet | `status.hold` (default Hold). Without that citation the ticket stays in intake. |
| NEEDS DIAGNOSIS | stays in intake |
| ALREADY SHIPPED, outside grant open | `status.hold` |
| ALREADY SHIPPED, commits on trunk, journey proven or not applicable | `status.dev` after dev promote |
| ALREADY SHIPPED, named repos, commits not on trunk | Canceled |
| Prior request `ask` with no symbols, commit on trunk | `status.dev` |
| Prior request `ask` with no symbols, commit not on trunk | Canceled |
| Landed, outside grant none | `status.dev` |
| Landed, outside grant open | `status.hold` |
| `ship.afterDev` ship steps succeed and `markStatus` is not false | `status.prod` |
| Ship step fails after dev was set | stays on `status.dev` |
| Promote or dev step fails before dev is set | stays in intake |

A missing prior-request line, outside-grant line, or journey line does not build and does not change status.

## Labels and markers

The engine writes two labels when a failure type has used its heal cap: `heal-exhausted`, and the failure type (`quality-red`, `merge-conflict`, `promote-failed`, `ship-failed`, `quality-pending`, `quality-unscheduled`, `runner-blocked`, or `other`). It also writes a `HEAL_EXHAUSTED` comment. The next run does not ground or heal that ticket.

The lease, the land resume, and the heal count are comments, not labels:

- `DELIVERY_LEASE` holds the ticket for one runner.
- `LAND_WAIT`, `LAND_EMPTY`, and `SHIP_WAIT` resume land without starting from ground.
- `OWNER_HEAL` records one edit of one failure type. The count survives the next run.

## One runner

Program mode runs one ticket at a time. Land merges one pull request at a time. An owner edit stops the page so the next page loads the edited trunk. A second edit of the same key does not start on that page.

## Pull request and merge

The worker pushes a branch. The lander opens the pull request, waits until quality is green on that head, and squash-merges. Every open pull request is ready before the first squash. One that is not ready leaves the others unmerged. Any actor may squash-merge once that check is green. A red quality check, a conflict, a refused merge, a dev promote failure, and a ship failure use the same heal. The heal answers `**Heal:**` edit, wait, or login.

The github forge reads check-runs with the token printed by `DELIVERY_LOOP_GITHUB_MINT` when that command is set. Other forge calls keep the forge token. The command prints a token, or one JSON object with `token` and `expires_at`. A bare token expires 60 minutes after the mint. The forge mints again when five minutes or less remain. A 401 or 403 from check-runs is a credential error. The forge does not read that check from another endpoint.

When `DELIVERY_LOOP_GITHUB_MINT` is set, each run mints once at startup and reads `/rate_limit` with that token. Later check-runs reuse it. A failed mint or rate-limit read is logged and the run continues. That read is not a check.

A Figma frame URL is the `figma.com` address. Surrounding markdown and a trailing `)` `]` `>` `.` `,` `;` or quote are not part of it. `node-id=1-2` is read as `1:2`. A 400 includes Figma's `err` or `message` and stops as a rejected request. A 403 or 404 stops as access and names `design.figmaTokenEnv`. The token, the headers, and a URL that contains a token are not written.

Each credential call logs its slot, endpoint class, and status, success included. A re-mint near expiry adds `refresh=1`. The run ends with a count by slot, endpoint class, and status. The token, the headers, and the request URL are not written. A worker launch that succeeds logs `status=200`. A launch that fails without an HTTP status logs `status=0`. `workerModel` is the cursor model id. The launch passes `{ id }` and the credential line names that id. An absent `workerModel` omits the model and logs that the account default is in use. A 5xx on a cursor launch waits one second and retries that slot once. A second 5xx uses the fallback slot. A recorded proof that passes, a promote or ship command that exits 0, and a squash that returns a commit each write one success line.

`worker: http` posts that same prompt to `workerHttp.startUrl` with an id the loop generates, and `model: { id }` when `workerModel` is set. It then reads `workerHttp.statusUrl`, replacing `{id}`, every `workerHttp.pollMs` until the status is `finished` or `failed`, or `workerHttp.maxWaitMs` passes. The defaults are 15000 and 3600000. `maxWaitMs` stays inside the hosted job budget of 360 minutes. `pending` and `running` are HTTP 200 and are not terminal. The start handler writes that pending record before it returns, so a missing record is not the normal path. The loop does not write the record. A non-2xx start fails the worker and does not start another launcher. Header maps name an env var, or the source `mint` or `gh-token`. Start logs `endpoint=worker-http-start`. Status logs `endpoint=worker-http-status`. A spent wait fails the worker with detail `http worker join exceeded maxWaitMs`.

## Promote and ship

Promote runs only after the trunk check is green, and only for repos named in `dev.promote.repos`. Ship does not run during sweep unless `ship.afterDev` is set. A zero exit with no outcome lines is success, including a store wait. `**Heal:**` wait runs the step again. `**Heal:**` login replaces the login and runs the step again. A pack reports one ticket with `delivery-loop outcome <ticket> COMPLETE`, `PARKED`, or `BLOCKED`, and an optional reason. Exit 0 means every ticket is COMPLETE. Exit 2 means a ticket is PARKED and none are BLOCKED, unless `ship.parkSuccess` is true. Any BLOCKED line exits 1. `ship.parkSuccess` defaults to false. Exit 75, or a non-zero exit with `delivery-loop transient <reason>`, waits and runs that ship or promote step again. `transient.maxAttempts` defaults to 3. Waits start at one second and double. `transient.maxWaitMs` defaults to 60000 and caps the sum. A spent budget reports the reason and does not edit an owner. A non-transient failure still edits the owner.

## Self-heal

edit changes the owner of the step that returned no. That owner may be the ticket branch, the checkout, a repo the command ships, or this package. Production promote and store continue use that same heal. A note or a side watcher is not the fix.

When the owner is this package, the edit opens a pull request on `engine-heal/<ticket>` with the label `engine-heal`. The pull request contains the next patch of `package.json` and `package-lock.json` after the highest `v*` tag. The first heal after `v1.0.0` is `1.0.1`. If that tag already exists, the edit stops. The opener pushes with the commit-actor token. The `pull_request` quality check gates that head. The engine-heal workflow squash-merges, reads the version from the merged `package.json`, tags that commit, and publishes the GitHub release. A pull request without the bump gets a comment and stops. A client pins the tag when it needs the change.

Each failure type has a cap. The default is 3. `heal.maxAttempts` changes the default. `heal.caps.<type>` overrides one type. The count is the `OWNER_HEAL` comments of that type on the ticket, so it survives the next run. At the cap the engine writes the labels and the exhausted comment and stops. A failed write of the `OWNER_HEAL` comment fails the heal. The attempt is not counted, so the cap cannot be skipped by ignoring that error.

```yaml
heal:
  maxAttempts: 3
  caps:
    quality-red: 3
    merge-conflict: 3
    promote-failed: 3
    ship-failed: 3
    quality-pending: 3
    quality-unscheduled: 3
    runner-blocked: 3
```

## What a client adds

The client keeps `delivery-loop.yaml`, the invariants file, and its prompt files. `delivery-loop init` and `delivery-loop update` refresh skills, the Cursor rule, and the runner workflow from a pinned tag. They leave the project file and the invariants file alone. An overlay may add a rule. It does not replace this skill or the conduct skill.
