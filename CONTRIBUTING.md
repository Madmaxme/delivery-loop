# Contributing

Branch from `main` and open a pull request. The `quality` workflow runs the tests. That check is the required gate. Any actor may squash-merge once quality is green on the head. Merging `main` into the branch is fine.

## Commit and pull request title

The title is one plain sentence, with no type prefix and no pull request number. Squash merge appends the number.

The body is a short explanation in plain sentences. Say what changed and why. A list is fine when the change has more than one part. Match the sentences already on `main`.

## Engine heals

A heal of this package opens a pull request on `engine-heal/<ticket>` with the label `engine-heal`. The opener sets `package.json` and `package-lock.json` to the next patch after the highest `v*` tag before the pull request opens. The first heal after `v1.0.0` is `1.0.1`. If that tag already exists, the opener stops. The opener pushes with the commit-actor token. The `engine-heal` workflow squash-merges when the `pull_request` `quality` check is green on that head, reads the version from the merged `package.json`, tags that commit, and publishes the GitHub release. A pull request without the bump gets a comment and stops. A head from another repository is left unmerged. A client pins the tag when it needs the change.
