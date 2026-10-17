# delivery-loop

Versioned autonomous delivery loop. Conduct rules, a GitHub Actions runner, and a swappable coding agent.

QuickWash is the first install. This repository is the product. It does not live under the QuickWash GitHub organization.

Licensed under Apache-2.0. See `LICENSE`. The repository stays private while it is in development. Making it public is a visibility change. The grant is already in place.

```bash
npm install -g github:Madmaxme/delivery-loop
delivery-loop init
delivery-loop connector add sentry
delivery-loop update
```

`init` and `update` replace installed skills, the runner workflow, and adapters. They leave `delivery-loop.yaml` and the invariants file alone.

The product remote is https://github.com/Madmaxme/delivery-loop. `bash scripts/bootstrap-remote.sh` pushes `main` there.
