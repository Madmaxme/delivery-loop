# delivery-loop

Versioned autonomous delivery loop. Conduct rules, a GitHub Actions runner, and a swappable coding agent.

QuickWash is the first install. This repository is the product. It does not live under the QuickWash GitHub organization.

Licensed under Apache-2.0. See `LICENSE`. The repository stays private while it is in development. Making it public is a visibility change. The grant is already in place.

```bash
npx @delivery-loop/cli init
npx @delivery-loop/cli connector add sentry
npx @delivery-loop/cli update
```

`init` and `update` replace installed skills, the runner workflow, and adapters. They leave `delivery-loop.yaml` and the invariants file alone.

## Create the private remote

Only a GitHub user can create the `delivery-loop` organization. After that, from this directory, with a user token that can create private repositories:

```bash
gh auth login
bash scripts/bootstrap-remote.sh
```

The script creates the private repo `delivery-loop/delivery-loop` and pushes `main`. It does not create the organization.
