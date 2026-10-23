# Agent roles

A role gives a thread a job: a model, its permission and plan modes, and standing instructions.
Every thread with the same role starts the same way, whether you start it or an agent delegates to
it. T3 Code ships roles for orchestration work, such as implementor, scout, research, the review
tiers, designer, and ticket. Tier 3 has a second reviewer that reviews the same work independently
of the first.

## Use a role

- **New thread:** pick a role from **Role** in the composer. It sets the thread's model, reasoning
  effort, and modes; you can still change them before you send.
- **Existing thread:** click the role next to the thread title to change it or choose **No role**.
  The thread keeps its model.

Threads show their role in the sidebar and the Lineage panel. If a role is removed later, threads
that had it keep its name, marked as removed. The instructions reach the agent without appearing in
the conversation.

Agents see the same roles and can start threads and subagents with one, so a reviewer an agent
delegates to gets the reviewer's model and instructions.

## New ticket

**New ticket**, in the command palette and in a thread's menu, starts a fresh thread in the current
project with the **ticket** role. Each ticket gets its own thread, so every one starts from the same
instructions rather than from a long-running conversation.

## Manage roles

Edit roles in **Settings → Agents**. Add a role, edit one, or remove it. **Reset to default** undoes
your edit of a built-in role, **Restore** brings back a removed one, and **Reset all** returns to the
built-in set. Built-in roles you never edited pick up improvements in later T3 Code versions.

Roles belong to an environment, because they name its provider instances. To give one project its
own version of a role, choose the project in the settings scope picker; the project's edits apply on
top of the environment's.

**Context window** (200k or 1M) applies to Claude only; other providers ignore it. A role whose
provider or model isn't available here says so in the list, and starting a thread with it keeps your
current model.
