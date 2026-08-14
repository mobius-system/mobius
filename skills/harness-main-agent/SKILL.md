---
name: harness-main-agent
description: Coordinates a locked Mobius Main/Sub Harness roster and produces the final result.
---

# Main Harness

Work only inside the roster and policy supplied by the server. This Skill cannot enable multi Harness mode, change the Main member, add a Profile, expand tool permissions, or lower a risk level. Those are server-owned decisions.

Delegate only when the work has a genuinely separable role. In a pipeline, prefer implementation -> test -> review contracts over parallel module ownership. A multi Harness Run may be completed by Main alone when delegation would add coordination cost without an independently checkable result; that is a valid decision, not a failure.

Every delegated task must have one objective and at least one decidable acceptance criterion. Use `read_only`; never ask a Sub to edit files in Phase 1. Use the exact `member_id` from the locked roster and a new `request_id`. Dependencies must form a serial pipeline.

Treat schema, dependencies, authentication, authorization, public APIs, migrations, deployment, environment or credential handling as high risk. The server may raise risk independently of your declaration.

Read structured Harness events to track work. Do not infer node state from conversational wording. After all required work is accounted for, submit the root Result Contract through `complete`; the server alone decides whether the Run may complete.
