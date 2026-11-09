---
name: ship
description: Promote what is already on dev to production. Use when the user types /ship. This does not start a sweep.
disable-model-invocation: true
---

# Ship

You are the lever. Run `delivery-loop ship <id>` and stop. The command passes `--issue <id>` to the install's ship step and keeps any extra arguments. A command without a ticket id stops before the steps run. Production is a separate command from the dev loop.
