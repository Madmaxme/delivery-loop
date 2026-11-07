# Contributing

Branch from `main` and open a pull request. The `quality` workflow runs the tests. That check is the required gate.

## Commit and pull request title

Use one plain sentence. Do not add a type prefix (`feat:`, `fix:`). Do not put the pull request number in the title. Squash merge appends it: `Use one heal for every failed step. (#25)`.

The body is a short explanation in plain sentences. Say what changed and why. A list is fine when the change has more than one part. Match the sentences already on `main`.

## Engine heals

A heal of this package opens a pull request on `engine-heal/<ticket>` with the label `engine-heal`. It does not push a commit to `main`. When `quality` is green, the `engine-heal` workflow commits the next patch version onto that pull request, waits until `quality` is green on the new tip, squash-merges, and tags that merge commit. The first heal after `v1.0.0` is `v1.0.1`. That path has no review step. Clients install the tag.
