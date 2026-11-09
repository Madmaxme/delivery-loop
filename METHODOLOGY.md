# Methodology

[conduct/methodology/SKILL.md](conduct/methodology/SKILL.md) is the master copy of the harness. [.cursor/rules/delivery-loop.mdc](.cursor/rules/delivery-loop.mdc) is the Cursor rule. [AGENTS.md](AGENTS.md) points agents at both. [conduct/conduct/SKILL.md](conduct/conduct/SKILL.md) is the code conduct those files reference. Clients pin a tag, for example `github:<owner>/<repo>#vX.Y.Z`, and add overlays: `delivery-loop.yaml`, the invariants file, and prompt files. Product names stay in the client repo.

`delivery-loop init` and `delivery-loop update` copy the skills, the Cursor rule, and the runner workflow from the pinned package. The runner clones that same tag.

## Roles

The orchestrator talks to the owner. The engineering bot owns the code and runs the loop. It dispatches sweeps, launches cloud agents, and merges, or leaves the merge to the lander or the engine-heal workflow. The lander opens one pull request per land repo and squash-merges it. Before `status.dev`, the engine posts one comment with the validated proof receipt, the merged SHA, and the pull request URL, and a resume reuses that comment. A resume applies the same recorded-proof check. A route-test proof matches `journeySpec`. A spec outside that pattern is not proof. GitHub is the record of the pull request, the checks, and the merge.

## Merge

Any actor may squash-merge once quality is green on the head. A branch that is only behind is updated from trunk, then quality runs again on the new head. Two updates are the limit. When the install lists `commitActors` for that repo, the token's login is that actor.

## Engine heal

An engine heal of this package opens a pull request on `engine-heal/<ticket>` with the label `engine-heal`. The opener commits the next patch of `package.json` and `package-lock.json`, computed from the highest `v*` tag, and pushes with the commit-actor token. The first heal after `v1.0.0` is `1.0.1`. If that tag already exists, the opener stops. The `pull_request` `quality` check gates that head. The workflow squash-merges, reads the version from the merged `package.json`, tags that commit, and publishes the GitHub release. A pull request without the bump gets a comment and stops. A head from another repository is left unmerged. A client pins the tag when it needs the change.

## Run events

A worker run may write `delivery-loop.run.started` and `delivery-loop.run.finished`. The writer is `scripts/run-event.sh`. The schema is [schemas/run-event-1.0.schema.json](schemas/run-event-1.0.schema.json). The script writes `.delivery-loop/events/<type>.json` and the workflow uploads the artifact `delivery-loop-run-events`. This package does not post the file. A client sets `DELIVERY_LOOP_EVENT_URL` to an http(s) endpoint and may set `DELIVERY_LOOP_EVENT_HEADER`. An empty URL only writes the file. A failed post leaves the run's own exit code. `DELIVERY_LOOP_EVENT_REQUIRED` set to `true` or `1` makes a failed post fail the run. The URL and the header are never printed.

## Lease

One runner holds the ticket with a `DELIVERY_LEASE` comment. The lease records the live agent id as soon as the worker starts.

## Bot definitions

A leftover `bots` key is ignored with a warning.
