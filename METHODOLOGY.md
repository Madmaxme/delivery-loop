# Methodology

[conduct/methodology/SKILL.md](conduct/methodology/SKILL.md) is the master copy of the harness. [.cursor/rules/delivery-loop.mdc](.cursor/rules/delivery-loop.mdc) is the Cursor rule. [AGENTS.md](AGENTS.md) points agents at both. [conduct/conduct/SKILL.md](conduct/conduct/SKILL.md) is the code conduct those files reference and do not copy.

Git tags version this copy. A client pins a tag, for example `github:Madmaxme/delivery-loop#v1.0.0`, and adds overlays in its own repo: `delivery-loop.yaml`, the invariants file, and prompt files. The client does not install `main`. Product names stay in the client repo.

`delivery-loop init` and `delivery-loop update` copy the skills, the Cursor rule, and the runner workflow from the pinned package. The runner workflow clones that same tag.

## Engine heal release

An engine heal of this package opens a pull request on `engine-heal/<ticket>` with the label `engine-heal`. The opener commits the next patch of `package.json` and `package-lock.json`, computed from the highest `v*` tag, and pushes with the commit-actor token. The first heal after `v1.0.0` is `1.0.1`. If that tag already exists, the opener stops. The workflow does not push a commit. Branch protection on `main` requires a pull request and a green `quality` check, with no approving review. `enforce_admins` stays off.

The `engine-heal` workflow waits until the `pull_request` `quality` check is green on that head, squash-merges, reads the version from the merged `package.json`, and tags that commit `vX.Y.Z`. The tag push is not blocked. A pull request that arrives without the bump gets a comment and stops. A `workflow_dispatch` run does not satisfy the required check, so the workflow does not start one.

## Run events

A worker run writes two JSON events, `delivery-loop.run.started` and `delivery-loop.run.finished`. The writer is `scripts/run-event.sh`. The schema is [schemas/run-event-1.0.schema.json](schemas/run-event-1.0.schema.json). `specversion` is `1.0`.

Each event has `specversion`, `id`, `source`, `type`, and `time`. `data` has `repo`, `sha`, `workflow`, `run_id`, `run_attempt`, `phase`, and `status`. `id` is `gh:<run id>:<run attempt>:<phase>`. `source` is `<server>/<repository>`. `time` is UTC. `sha` is the workflow_run head sha when that payload has one, otherwise `GITHUB_SHA`. `phase` is `started` or `finished`. `status` is the second argument, or empty. `type` is `delivery-loop.run.` plus the phase. The script builds the JSON with `jq` when `jq` is on `PATH`, and with bash otherwise.

The script writes `.delivery-loop/events/<type>.json` under `GITHUB_WORKSPACE`, or under the current directory when that variable is empty. It does not print the file. The workflow uploads that directory as the artifact `delivery-loop-run-events`. The directory name starts with a dot, so the upload sets `include-hidden-files`. The file has no endpoint and no header.

`engine-heal` records `started` after checkout and before Node, install, and the merge. It records `finished` with `job.status` and `if: always()`, then uploads the artifact with `if: always()`. That workflow does not set an endpoint, so it never posts. The merge and the tag use `github.token`. The job still runs only after a successful `pull_request` quality run. A run that does not match never starts a runner. `quality` does not write an event, so this record cannot turn a pull request red.

`templates/runner.yml` is what a client copies. It calls the same script after the package clone and before `npm install`, and again after the loop. It uploads the same artifact. A post is optional and belongs to the client. The client sets the repository variable `DELIVERY_LOOP_EVENT_URL` to an http(s) endpoint. `DELIVERY_LOOP_EVENT_HEADER` is an optional single header line, taken from the client's own store. `DELIVERY_LOOP_EVENT_REQUIRED` defaults to false. When it is `true` or `1`, a failed post fails the run. Otherwise a failed post leaves the run's own exit code. When the started post fails and the flag is set, the runner still writes `finished` with status `failure` and does not start the loop. When the URL is empty, the script only writes the file. The script never prints the URL or the header.

An integrator reads the artifact, or sets the endpoint in its own repository. This package does not name an endpoint and does not ship one.

## Bot definitions

`bots/templates/` holds role templates. A client holds instances of those roles, in the directory named by `bots.path` on its pack. The key is optional. When it is absent, the engine does not read a bots directory.

An orchestrator instance and a verdict-writer instance belong to one client. Each business has its own. A client's delivery-agent instance may be shared across clients if it is the same bot everywhere.

The delivery agent is the harness execution agent. It is one of the engine's roles. It thinks, then calls the forge, tracker, worker, and connector adapters. Those interfaces, the loop, and engine-heal are the source of what it can do. A GitHub App or other identity that opens a pull request or merges when checks are green is an execution identity the delivery agent calls. It is not an agent and not a role.

The delivery agent reads check-runs on the exact reviewed head. The merge is a squash of that head, and only when those checks are green. An identity that opened or pushed the head does not merge it. Review is independent of that identity. There is no rebase. There is no force-merge when a check on that head is red.

The orchestrator monitors existing delivery runs and reports evidence. It does not start, dispatch, re-dispatch, resume, or run the delivery loop, including a scheduled sweep and a ground-only compile. It does not write a delivery status or a delivery label.

The inventory cross-checks the three roles. It does not add a capability. A source that was not read is a coverage gap with status `unreached` or `unverified`, a reason, and a timestamp. The gap is written down. It is not omitted.

The files are data. They do not relax a gate and they do not grant authority. `delivery-loop bots validate` and `delivery-loop bots list` only read. They do not schedule a routine.
