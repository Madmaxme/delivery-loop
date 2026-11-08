# Contributing

Branch from `main` and open a pull request. The `quality` workflow runs the tests. That check is the required gate.

## Commit and pull request title

Use one plain sentence. Do not add a type prefix (`feat:`, `fix:`). Do not put the pull request number in the title. Squash merge appends it: `Use one heal for every failed step. (#25)`.

The body is a short explanation in plain sentences. Say what changed and why. A list is fine when the change has more than one part. Match the sentences already on `main`.

## Engine heals

A heal of this package opens a pull request on `engine-heal/<ticket>` with the label `engine-heal`. The opener sets `package.json` and `package-lock.json` to the next patch after the highest `v*` tag before the pull request opens. The first heal after `v1.0.0` is `1.0.1`. If that tag already exists, the opener stops. The opener pushes with the commit-actor token. The `engine-heal` workflow does not push a commit. It squash-merges only when the pull request has that branch and that label, every changed file is on the auto-merge allowlist: `src/connectors` source, or a version-only package.json and package-lock.json. `src/engine`, `src/adapters`, `src/schema`, `src/bots`, and any other path need a normal review, and the green `pull_request` `quality` run is GitHub Actions on that exact head with the same `.github/workflows/quality.yml` file as `main`. It then reads the version from the merged `package.json` and tags that commit. A version-only bump of `package.json` and `package-lock.json` is the auto-merge path and has no review step. Anything else, including an unknown proof, gets a comment and a normal review. The workflow does not merge or tag it. A pull request without the bump gets a comment and stops. Clients install the tag. Open that pull request from this repository, because a head from a fork is not merged.
