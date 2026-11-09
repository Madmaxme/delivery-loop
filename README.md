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

## Bot definitions

A leftover `bots` key is ignored with a warning.

## Contribute

Clone this repo, branch from `main`, and open a pull request. The `quality` workflow runs the tests. Titles and bodies are in [CONTRIBUTING.md](CONTRIBUTING.md).

A new tracker, forge, or worker is a file in `src/adapters` plus a test. Trackers implement `listIntake`, `get`, `comment`, and `setState`. Workers implement `start` and `join`. Forges implement `openPullRequest`, `quality`, `mergeability`, `compare`, `updateBranch`, and `squashMerge`. `squashMerge` returns the merge commit.

An install keeps its repos, trunk branches, status names, and promote commands in its own `delivery-loop.yaml`.

The runner prepends `conduct/conduct/SKILL.md` to every ground and build prompt. That file is the universal law: one code path, evidence before building, a work order that cites an invariant which already exists, a green quality check, `**Prior request:**`, `**Outside grant:**`, and `**Journey evidence:**`. A recorded journey marks dev-done with proof: an https recording or screenshot URL in the build receipt, or a route test on the merged commit whose path matches `journeySpec`. A spec outside that pattern is not proof. An install's prompt files and invariants file hold the concrete proof.

A rule about how any ticket moves belongs in this repository. An install's product names, repos, and proof belong in that install. `status.hold` is the install's name for the status that does not clear blockers after owned code lands and the grant is still outside the repo. The default is `Hold`. `status.dev` and `status.prod` stay the done states.

`design` names UI repos. When a ticket has a `figma.com` frame in the description, a comment, or a tracker attachment, the work order includes `**Design source:**` with that URL. The runner reads the frame from the Figma REST API using the env var named by `design.figmaTokenEnv`. The package does not ship a token. When a frame is present and that variable is empty, the runner stops with `missing-credential: figma`. Token and secret values are never printed or stored. When the ticket has no frame and a land repo is listed under `design.repos`, Validation includes that repo's `check` command. After the pull request opens, the runner reads the check run named `checkName` on that pull request's head sha. A result recorded on a different sha is ignored. A missing or red check is a quality failure and uses the same heal cap.

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
