# delivery-loop

Versioned autonomous delivery loop. Conduct rules, a GitHub Actions runner, and a swappable coding agent.

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

The product remote is https://github.com/Madmaxme/delivery-loop. `bash scripts/bootstrap-remote.sh` pushes `main` there.

## Contribute

Clone this repo, branch from `main`, and open a pull request. The `quality` workflow runs the tests.

A new tracker or worker is a file in `src/adapters` plus a test. Trackers implement `listIntake`, `get`, `comment`, and `setState`. Workers implement `start` and `join`.

An install keeps its repos, trunk branches, status names, and promote commands in its own `delivery-loop.yaml`. Those facts do not belong in this repository.

The runner prepends `conduct/conduct/SKILL.md` to every ground and build prompt. That file is the universal law: one code path, evidence before building, a work order that cites an invariant which already exists, a green quality check, and `**Outside grant:** none | open`. An install's prompt files and invariants file hold the concrete proof: type safety, which document is the source of truth, when to split a module, and making a shared primitive safe before its callers.

A rule about how any ticket moves belongs in this repository. An install's product names, repos, and proof belong in that install. `status.hold` is the install's name for the status that does not clear blockers after owned code lands and the grant is still outside the repo. The default is `Shaping`. `status.dev` and `status.prod` stay the done states.

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
