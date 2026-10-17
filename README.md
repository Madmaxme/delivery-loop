# delivery-loop

Versioned autonomous delivery loop. Conduct rules, a GitHub Actions runner, and a swappable coding agent.

An install keeps its own `delivery-loop.yaml` and invariants file. This repository does not name those projects.

Licensed under Apache-2.0. See `LICENSE`. The repository stays private while it is in development. Making it public is a visibility change. The grant is already in place.

```bash
npm install -g github:Madmaxme/delivery-loop
delivery-loop init
delivery-loop connector add sentry
delivery-loop update
```

`init` and `update` replace installed skills, the runner workflow, and adapters. They leave `delivery-loop.yaml` and the invariants file alone.

The product remote is https://github.com/Madmaxme/delivery-loop. `bash scripts/bootstrap-remote.sh` pushes `main` there.

## Contribute

Clone this repo, branch from `main`, and open a pull request. The `quality` workflow runs the tests.

A new tracker or worker is a file in `src/adapters` plus a test. Trackers implement `listIntake`, `get`, `comment`, and `setState`. Workers implement `start` and `join`.

An install keeps its repos, trunk branches, status names, and promote commands in its own `delivery-loop.yaml`. Those facts do not belong in this repository.
