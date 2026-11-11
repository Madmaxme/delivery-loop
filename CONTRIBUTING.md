# Contributing

Branch from `main` and open a pull request. The `quality` workflow runs the tests. That check is the required gate. Any actor may squash-merge an ordinary pull request once quality is green on the head; engine-heal pull requests are merged by their workflow. Merging `main` into the branch is fine.

## Commit and pull request title

The title is one plain sentence, with no type prefix and no pull request number. Squash merge appends the number.

The body is a short explanation in plain sentences. Say what changed and why. A list is fine when the change has more than one part. Match the sentences already on `main`.

## Engine heals

A routine package heal opens `engine-heal/<ticket>` with the `engine-heal` label and sets `package.json` and `package-lock.json` to the next patch after the highest `v*` tag. The first routine heal after `v1.0.0` is `1.0.1`; `engineHealBumpVersion` remains patch-only. The planned breaking v2.0.0 release is a deliberate greater-version bump from main's v1.0.17 and uses the same labeled pull-request workflow. The opener pushes with the commit-actor token. The `engine-heal` workflow waits for green `pull_request` quality, squash-merges, then alone writes the tag and publishes the GitHub release. Do not create a tag or release directly; clients pin the resulting tag.
