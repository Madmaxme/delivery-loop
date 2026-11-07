# Agents

This repository is the delivery-loop engine. The master methodology is [conduct/methodology/SKILL.md](conduct/methodology/SKILL.md). The Cursor rule is [.cursor/rules/delivery-loop.mdc](.cursor/rules/delivery-loop.mdc). Code conduct is [conduct/conduct/SKILL.md](conduct/conduct/SKILL.md). Follow that file. Do not paste it into a client repo.

An edit of this package does not merge to `main`. Open a pull request. Branch `engine-heal/<ticket>` and label `engine-heal` when the edit is a heal of this package. The `quality` check gates the pull request. The engine-heal workflow commits the next patch on that pull request, waits until `quality` is green on that tip, squash-merges, and tags the merge commit. It does not push a commit to `main`. Clients install a git tag, not `main`.

Commit subjects are one plain sentence. The body explains the change. See [CONTRIBUTING.md](CONTRIBUTING.md).
