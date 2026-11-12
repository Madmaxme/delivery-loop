---
name: ship
description: Promote what is already on dev to production. Use when the user types /ship, asks to continue an active ship stage, or asks for the ship sweep. This does not start an intake sweep.
disable-model-invocation: true
---

# Ship

You are the lever. Run one ship command and stop. `delivery-loop ship <id>` passes `--issue <id>` to the install's ship step. `delivery-loop ship continue <id>` resumes that ticket's active ship stage. `delivery-loop ship continue` with no id resumes each active ship stage. `delivery-loop ship sweep` reads due `ship-retry` markers and parked ship stages and runs each as a fresh `ship` or `ship continue`. A `ship <id>` command without a ticket id stops before the steps run. Production is a separate command from the dev loop.

Every ship stage sets `approval`. The shape is `{ source: list, issues: [ids] }` or `{ source: label, label: <name> }`. `ship`, `ship continue`, and `ship sweep` check it before any promote or continue command, including a repository dispatch. The trigger does not matter. An unapproved ticket carried in the release blocks with `approval-missing`. The carried tickets are the named ticket, every id on a list approval, and every intake ticket that has a `ship-retry` marker or a parked ship receipt for the current criteria revision. There is no automated production ship without approval.

A stage command prints `{ outcome, reason, step? }`. Only `broken` opens a heal. `waiting` and `needs-step` write a `ship-retry` marker and end the run. After a heal returns edit or wait, the run writes that marker and exits. The marker records the ticket, the stage, the reason, and `notBefore`. Do not wait in this run and do not start another ship from this skill. The next fresh run reads the merged code.

A `ship-lock` marker holds the run id and an expiry of one hour. The same run may retake it. Another live run gets `waiting`. An expired lock is taken.

Read the engine's ship contract in [METHODOLOGY.md](../../METHODOLOGY.md) before changing how a stage promotes, verifies, parks, or writes status. Stop when the command exits. Do not merge, tag, or write a release unless the owner asked for that as a separate step. When the ship path blocks, report the stage id and the reason. Do not invent a retry, a dispatch, or a second ship command.
