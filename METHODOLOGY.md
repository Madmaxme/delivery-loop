# Methodology

[conduct/methodology/SKILL.md](conduct/methodology/SKILL.md) is the master copy of the harness. [.cursor/rules/delivery-loop.mdc](.cursor/rules/delivery-loop.mdc) is the Cursor rule. [AGENTS.md](AGENTS.md) points agents at both. [conduct/conduct/SKILL.md](conduct/conduct/SKILL.md) is the code conduct those files reference and do not copy.

Git tags version this copy. A client pins a tag, for example `github:Madmaxme/delivery-loop#v1.0.0`, and adds overlays in its own repo: `delivery-loop.yaml`, the invariants file, and prompt files. The client does not install `main`. Product names stay in the client repo.

`delivery-loop init` and `delivery-loop update` copy the skills, the Cursor rule, and the runner workflow from the pinned package. The runner workflow clones that same tag.
