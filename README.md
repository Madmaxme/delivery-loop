# delivery-loop

Versioned autonomous delivery loop. Four things are required. The vendor behind each one is an adapter.

1. **Git** holds the code, the branch, and the merge. `forge: github` opens a pull request. `forge: git` merges with git on any remote.
2. **A work queue** is a real shared list of what is next, what is blocked, and what is done. `tracker: linear` or `tracker: github`. Files in the repo are not a queue.
3. **A runner** executes commands with nobody sitting there. `runner: gha` is GitHub Actions. `runner: local` is this process. One of them is required.
4. **A coding worker** edits the code. The runner starts it and waits. `worker` is `cursor`, `claude`, `codex`, `copilot`, or `http`.

`check: workflow` polls the named quality workflow on GitHub. `check: command` runs `qualityCommand` in the checkout. A workflow check requires `forge: github`.

Land merges one pull request at a time, in `repos` order from the install pack. A branch that is only behind an open pull request is updated, then quality runs again on the new head. A branch that is identical to trunk, or has no commits of its own, is not opened. The next sweep leaves that ticket alone while that commit is still the branch tip. A red quality check on the pull request starts the coding worker on that same branch, up to the fix budget, and the next page resumes land. A conflict or a refused merge starts that same worker on that same branch. After the squash, quality runs on the trunk tip that contains the merge. A later green commit on that trunk counts. A red or pending tip stays in intake. The runner does not start a coding worker from trunk. The next page reads that tip again, and a page that is still waiting starts the next page. When the install sets `dev.promote`, the runner executes that command for each landed repo named in `dev.promote.repos`, and only after the trunk check is green. The sweep continues with the next ticket. When a ticket lands or a verdict moves it, the sweep reads the queue again in that same page so a ticket that was waiting on it can run. The runner writes one line when a ticket enters ground, build, or land, and one line when that ticket finishes. The JSON list is still printed when the page returns.

An install keeps its own `delivery-loop.yaml` and invariants file. This repository does not name those projects.

Licensed under Apache-2.0. See `LICENSE`. The repository is public.

```bash
npm install -g github:Madmaxme/delivery-loop
delivery-loop init
delivery-loop connector add sentry
delivery-loop update
```

`init` and `update` replace installed skills, the runner workflow, and adapters. They leave `delivery-loop.yaml` and the invariants file alone.

The runner clones https://github.com/Madmaxme/delivery-loop over HTTPS. It installs dependencies in that checkout before the global install, because `npm install -g <dir>` only symlinks the directory.

The product remote is https://github.com/Madmaxme/delivery-loop. `bash scripts/bootstrap-remote.sh` pushes `main` there only when `GET /user` on the token is that remote's owner. An install names the same rule with `commitActors`: a write to one of those repos is refused unless the token's login is the actor. Other repos keep whatever account the token already is.

## Contribute

Clone this repo, branch from `main`, and open a pull request. The `quality` workflow runs the tests.

A new tracker, forge, or worker is a file in `src/adapters` plus a test. Trackers implement `listIntake`, `get`, `comment`, and `setState`. Workers implement `start` and `join`. Forges implement `openPullRequest`, `quality`, `mergeability`, `compare`, `updateBranch`, and `squashMerge`. `squashMerge` returns the merge commit.

An install keeps its repos, trunk branches, status names, and promote commands in its own `delivery-loop.yaml`. Those facts do not belong in this repository.

The runner prepends `conduct/conduct/SKILL.md` to every ground and build prompt. That file is the universal law: one code path, evidence before building, a work order that cites an invariant which already exists, a green quality check, `**Prior request:** none | kept | replaced <id> | ask`, and `**Outside grant:** none | open`. An install's prompt files and invariants file hold the concrete proof: type safety, which document is the source of truth, when to split a module, and making a shared primitive safe before its callers.

A rule about how any ticket moves belongs in this repository. An install's product names, repos, and proof belong in that install. `status.hold` is the install's name for the status that does not clear blockers after owned code lands and the grant is still outside the repo. The default is `Hold`. `status.dev` and `status.prod` stay the done states.

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
