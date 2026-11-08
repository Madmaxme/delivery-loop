# delivery-loop

Versioned autonomous delivery loop. Four things are required. The vendor behind each one is an adapter.

1. **Git** holds the code, the branch, and the merge. `forge: github` opens a pull request. `forge: git` merges with git on any remote.
2. **A work queue** is a real shared list of what is next, what is blocked, and what is done. `tracker: linear` or `tracker: github`. Files in the repo are not a queue.
3. **A runner** executes commands with nobody sitting there. `runner: gha` is GitHub Actions. `runner: local` is this process. One of them is required.
4. **A coding worker** edits the code. The runner starts it and waits. `worker` is `cursor`, `claude`, `codex`, `copilot`, or `http`.

`check: workflow` polls the named quality workflow on GitHub. `check: command` runs `qualityCommand` in the checkout. A workflow check requires `forge: github`.

Land merges one pull request at a time, in `repos` order from the install pack. A branch that is only behind an open pull request is updated, then quality runs again on the new head. A branch that is identical to trunk, or has no commits of its own, is not opened. The next sweep leaves that ticket alone while that commit is still the branch tip. A red quality check, a conflict, or a refused merge uses one heal. The heal answers edit, wait, or login. edit changes the owner of the failure. When that owner is this package, the edit opens an `engine-heal/` pull request that already contains the next patch after the highest `v*` tag, and does not push a commit to main. The `pull_request` `quality` check gates it. The workflow does not push a commit. It waits until that check is green, squash-merges, and tags that merge commit. Clients install that tag. After the squash, quality runs on the trunk tip that contains the merge. A later green commit on that trunk counts. A red or pending tip stays in intake. The runner does not start a coding worker from trunk. The next page reads that tip again, and a page that is still waiting starts the next page. When the install sets `dev.promote`, the runner executes that command for each landed repo named in `dev.promote.repos`, and only after the trunk check is green. The sweep continues with the next ticket. When a ticket lands or a verdict moves it, the sweep reads the queue again in that same page so a ticket that was waiting on it can run. The runner writes one line when a ticket enters ground, build, or land, and one line when that ticket finishes. The JSON list is still printed when the page returns.

An install keeps its own `delivery-loop.yaml` and invariants file. This repository does not name those projects.

Licensed under Apache-2.0. See `LICENSE`. The repository is public.

```bash
npm install -g github:Madmaxme/delivery-loop#v1.0.0
delivery-loop init
delivery-loop connector add sentry
delivery-loop update
```

`init` and `update` replace installed skills, the Cursor rule, and the runner workflow. They leave `delivery-loop.yaml` and the invariants file alone.

The runner clones the pinned tag of https://github.com/Madmaxme/delivery-loop over HTTPS. It installs dependencies in that checkout before the global install, because `npm install -g <dir>` only symlinks the directory.

The product remote is https://github.com/Madmaxme/delivery-loop. `bash scripts/bootstrap-remote.sh` pushes `main` there only when `GET /user` on the token is that remote's owner. An install names the same rule with `commitActors`: a write to one of those repos is refused unless the token's login is the actor. Other repos keep whatever account the token already is.

## Methodology

[METHODOLOGY.md](METHODOLOGY.md) is the index. [conduct/methodology/SKILL.md](conduct/methodology/SKILL.md) is the master copy, versioned by git tags. [conduct/conduct/SKILL.md](conduct/conduct/SKILL.md) is the code conduct that copy references. A client pins a tag and adds overlays. It does not install `main`.

```bash
npm install -g github:Madmaxme/delivery-loop#v1.0.0
```

## Run events

A worker run writes `delivery-loop.run.started` and `delivery-loop.run.finished` as JSON files and uploads those files as a workflow artifact. The writer is `scripts/run-event.sh`. This repository does not post those files. A client workflow posts one only when that client sets `DELIVERY_LOOP_EVENT_URL`. The field contract is in [METHODOLOGY.md](METHODOLOGY.md).

## Bot definitions

Optional. A client pack may set `bots.path` to a directory of bot instances, relative to `delivery-loop.yaml`. When the key is absent, the engine reads nothing there and the loop is unchanged.

This repository holds role templates in `bots/templates/`. The roles are the orchestrator, the verdict writer, and the delivery agent. The delivery agent is the harness execution agent. Its tools are the forge, tracker, worker, and connector adapters. A GitHub App that opens a pull request or merges on green is an execution identity that agent calls, not a bot of its own.

An orchestrator instance and a verdict-writer instance are per client. A delivery-agent instance may be shared across clients when it is the same bot everywhere. The inventory is a cross-check of those roles. A source that was not read is a coverage gap (`unreached` or `unverified`, with a reason and a timestamp), not a missing row.

Definitions are data. They do not relax a gate and they do not grant authority. Policy ids record the role bounds. This layer does not install a runtime identity-separation gate. `bots.path` must stay inside the client directory. `delivery-loop bots validate` checks them. `delivery-loop bots list` prints the inventory. Neither command uses a credential, the network, or a write, and neither dispatches or schedules. See [bots/README.md](bots/README.md).

## Contribute

Clone this repo, branch from `main`, and open a pull request. The `quality` workflow runs the tests. Titles and bodies are in [CONTRIBUTING.md](CONTRIBUTING.md).

A new tracker, forge, or worker is a file in `src/adapters` plus a test. Trackers implement `listIntake`, `get`, `comment`, and `setState`. Workers implement `start` and `join`. Forges implement `openPullRequest`, `quality`, `mergeability`, `compare`, `updateBranch`, and `squashMerge`. `squashMerge` returns the merge commit.

An install keeps its repos, trunk branches, status names, and promote commands in its own `delivery-loop.yaml`. Those facts do not belong in this repository.

The runner prepends `conduct/conduct/SKILL.md` to every ground and build prompt. That file is the universal law: one code path, evidence before building, a work order that cites an invariant which already exists, a green quality check, `**Prior request:** none | kept | replaced <id> | ask`, `**Outside grant:** none | open`, and `**Journey evidence:** recorded | not-applicable | blocked`. A recorded journey marks dev-done only with a proof token: an https recording or screenshot URL in the build receipt, or a route test on the merged commit. An install's prompt files and invariants file hold the concrete proof: type safety, which document is the source of truth, when to split a module, and making a shared primitive safe before its callers.

A rule about how any ticket moves belongs in this repository. An install's product names, repos, and proof belong in that install. `status.hold` is the install's name for the status that does not clear blockers after owned code lands and the grant is still outside the repo. The default is `Hold`. `status.dev` and `status.prod` stay the done states.

`design` names UI repos. When a ticket has a `figma.com` frame in the description, a comment, or a tracker attachment, the work order must include `**Design source:**` with that URL. The runner reads the frame from the Figma REST API. The token is the env var `design.figmaTokenEnv`, which defaults to `FIGMA_ACCESS_TOKEN`. The package does not ship a token and does not start when a frame is present and the variable is empty. The stop is `missing-credential: figma`. When the ticket has no frame and a land repo is listed under `design.repos`, Validation must include that repo's `check` command. After the pull request opens, the runner reads the check run named `checkName` on that pull request's head sha. A result recorded on a different sha is ignored. A missing or red check is a quality failure and uses the same heal cap. The repair prompt includes the frame URL and the REST read, or the repo's `tokenFile` path and contents when there is no frame.

```yaml
design:
  figmaTokenEnv: FIGMA_ACCESS_TOKEN
  repos:
    - name: web
      check: npm run check:ui-primitives
      checkName: ui-primitives
      tokenFile: src/tokens.css
```

`prompts.ground` and `prompts.build` are workspace-relative files the runner puts in the worker prompt after that law. `invariantHeadings` lists heading files that count as invariant ids beside `invariantsFile`. A heading titled `Commission resolution` in a file with `prefix: billing` is the id `billing/commission-resolution`.

```yaml
prompts:
  ground:
    - docs/grounding.md
  build:
    - docs/build.md
invariantHeadings:
  - prefix: billing
    file: docs/rules/billing.md
```
