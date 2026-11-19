---
name: ship
description: Promote what is already on dev to production. Use when the user types /ship, asks to continue an active ship stage, or asks for the ship sweep. This does not start an intake sweep.
disable-model-invocation: true
---

# Ship

You are the lever. Run one ship command and stop. `delivery-loop ship <id>` passes `--issue <id>` to the install's ship step. `delivery-loop ship continue <id>` resumes that ticket's active ship stage. `delivery-loop ship continue` with no id resumes each active ship stage. `delivery-loop ship sweep` reads due `ship-retry` markers and parked ship stages and runs each as a fresh `ship` or `ship continue`. A `ship <id>` command without a ticket id stops before the steps run. Production is a separate command from the dev loop.

Every ship stage sets `approval`. The shape is `{ source: selection }`, `{ source: list, issues: [ids] }`, or `{ source: label, label: <name> }`. `selection` approves the tickets named on this command. `ship <id>` sends that ticket. `ship <id> <id>` sends each named ticket. `ship all` sends the trunk. Before promote or continue, the engine calls that command once with `{ phase: "plan" }` on stdin, including `selection`. The command returns `{ carries, untracked }` for the commits it will promote. Every carried ticket must pass that stage's approval, or the ship blocks with `approval-missing` and nothing is promoted. Untracked commits are listed in the ship log and the tracker summary. They stay off the prod ref. There is no `approval.untracked` key. A selection that is the whole range fast-forwards. Any other selection promotes only those commits, and a conflict stops the run and names the commit. Plan, promote, verify, and continue each receive `releaseSet`, `selection`, and the stage target. Ship eligibility comes only from current delivery receipts. `status.complete` and `status.shipped` are written after receipts pass and are not read as proof. There is no automated production ship without a named selection, list, or label.

A stage command prints `{ outcome, reason, step? }`. Only `broken` opens a heal. `waiting` and `needs-step` write a `ship-retry` marker and end the run. After a heal returns edit or wait, the run writes that marker and exits. The marker records the ticket, the stage, the reason, and `notBefore`. Do not wait in this run and do not start another ship from this skill. The next fresh run reads the merged code.

A `ship-lock` marker holds the run id and an expiry of one hour. The same run may retake it. Another live run gets `waiting`. An expired lock is taken.

Read the engine's ship contract in [METHODOLOGY.md](../../METHODOLOGY.md) before changing how a stage promotes, verifies, parks, or writes status. Stop when the command exits. Do not merge, tag, or write a release unless the owner asked for that as a separate step. When the ship path blocks, report the stage id and the reason. Do not invent a retry, a dispatch, or a second ship command.
