# Contributing

Branch from `main` and open a pull request. The `quality` workflow runs the tests. That check is the required gate.

## Commit and pull request title

Use one plain sentence. Do not add a type prefix (`feat:`, `fix:`). Do not put the pull request number in the title. Squash merge appends it: `Use one heal for every failed step. (#25)`.

The body is a short explanation in plain sentences. Say what changed and why. A list is fine when the change has more than one part. Match the sentences already on `main`.

## Engine heals

A heal of this package opens a pull request on `engine-heal/<ticket>` with the label `engine-heal`. The opener sets `package.json` and `package-lock.json` to the next patch after the highest `v*` tag before the pull request opens. The first heal after `v1.0.0` is `1.0.1`. If that tag already exists, the opener stops. The opener pushes with the commit-actor token. The `engine-heal` workflow does not push a commit. It waits until the `pull_request` `quality` check is green on that head, squash-merges, reads the version from the merged `package.json`, and tags that commit. A pull request without the bump gets a comment and stops. That path has no review step. Clients install the tag.

`engine-heal` writes the worker ledger before that merge. The secrets are `LEDGER_WEBHOOK_URL` and `LEDGER_WEBHOOK_AUTH`. If either is empty, or the POST fails, the job prints `::error title=Ledger write failed::...` and stops. The message does not contain the secret values. The `quality` check does not use these secrets. The contract is in [METHODOLOGY.md](METHODOLOGY.md).
