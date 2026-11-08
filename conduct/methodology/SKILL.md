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
7. The pull request merges only when quality is green and the forge reports the branch clean. Any actor may squash-merge that head. Quality is the `quality` workflow, or `qualityCommand` when `check` is `command`. A branch that is only behind is updated from trunk, then quality runs again on the new head. Two updates are the limit. A conflict or a refused merge is a heal.
8. The merge is a squash. Quality then runs on the trunk tip that contains the merge. A later green commit on that trunk counts. A red or pending tip stays in intake. The runner does not start a coding worker from trunk.
9. When the trunk check is green, `dev.promote` runs its command once for each landed repo that is also listed in `dev.promote.repos`. `{repo}` is replaced. When `promote` is set, `dev.steps` are not run. Otherwise `dev.steps` run.
10. The ticket moves to `status.dev`, or to `status.hold` when `**Outside grant:**` is open. Before the `status.dev` write, the engine posts one comment with the validated proof receipt, the merged SHA, and the pull request URL, and a resume reuses that comment. Hold does not clear blockers. The default hold name is Hold.
11. Journey evidence `recorded` marks dev-done only with proof. A web journey needs an https recording or screenshot URL in the build receipt. A mobile journey needs the route test on the merged commit.
12. `ship` is a separate command. `ship.afterDev` runs ship steps after the dev gate. A failed ship step leaves the dev status. `ship.markStatus: false` does not move the ticket to prod. Store continue is `ship continue`.

When a ticket lands or a verdict moves it, the same sweep reads the queue again so a ticket that was waiting on it can run. The runner writes one line when a ticket enters ground, build, or land, and one line when it finishes.

## Statuses the engine writes

| When | Status |
| --- | --- |
| Sweep intake | reads `status.intake` (default Todo). It does not move a ticket there. |
| WRONG DIAGNOSIS | Canceled |
| NEEDS RESCOPE after a cited harness packet | `status.hold` (default Hold). Without that citation the ticket stays in intake. |
| NEEDS DIAGNOSIS | stays in intake |
| ALREADY SHIPPED, outside grant open | `status.hold` |
| ALREADY SHIPPED, commits on trunk, journey proven or not applicable | `status.dev` |
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

The worker pushes a branch. The lander opens the pull request, waits until quality is green on that head, and squash-merges. Any actor may squash-merge once that check is green. A red quality check, a conflict, a refused merge, a dev promote failure, and a ship failure use the same heal. The heal answers `**Heal:**` edit, wait, or login.

## Promote and ship

Promote runs only after the trunk check is green, and only for repos named in `dev.promote.repos`. Ship does not run during sweep unless `ship.afterDev` is set. A clean ship exit, including a store wait, is not a failure. `**Heal:**` wait runs the step again. `**Heal:**` login replaces the login and runs the step again.

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
