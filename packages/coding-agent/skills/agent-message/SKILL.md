---
name: agent-message
description: Message family members by role, or any local-space agent by session name or ID when Cotal messaging is enabled. Sender identity comes from the daemon.
---

# Agent Message

Send direct messages within the current agent's nuclear family through the
local daemon: parent, siblings, and direct children. Roots are siblings.
With Cotal messaging enabled, omit `receiver_role` to address any session in the
local space by name or session ID. The daemon derives your sender identity from
the current session; do not try to include a `from` field.

Call directly from the kernel:

```python
children = await rlm.list_subagents()
child = next((item for item in children if item.active_session_id), None)
if child is not None:
    receipt = await agent_message.send(
        "Please inspect the latest result.",
        receiver_role="child",
        receiver_name=child.session_name,
    )
    # Keep the child until this follow-up finishes so its result remains observable.
```

## API

- `await agent_observe.list_agents()` (agent-observe skill) is the roster: it
  lists the parent, siblings, and children this skill can reach, active or not,
  with the `relationship` and `sessionName` that `send` takes as
  `receiver_role` and `receiver_name`.
- `await agent_message.send(message, receiver_role="parent" | "sibling" | "child", receiver_name=None, operation_id=None)` — sends one direct
  text message to one family member. Sending to an inactive or idle completed
  subagent wakes it and starts an ordinary follow-up turn in that same session
  and context.
  The child remains available only until its parent session closes. The daemon
  resolves `receiver_role` within the current agent family; `receiver_name` is
  required for siblings and children and omitted for the unique parent.
  `send("all", message)` broadcasts only to the family roster and returns
  `{receipts: [...]}` in roster order; successful entries are ordinary receipts
  and failed entries contain the target id and a short `error`. One failed delivery
  does not reject successful deliveries. Messages always use steering delivery so
  a busy target sees them during its active run. Returns a receipt with a
  `deliveryStatus` field: `"delivered"` means the message reached an idle target's
  context; `"queued"` means a steering message was accepted and will deliver when
  the target's current work allows (`send` does not block waiting for that).
  Delivered receipts carry `deliveredAt`, queued receipts carry `queuedAt`.
- `await agent_message.send(message, receiver_name="name-or-session-id")` —
  with Cotal enabled, sends to any enrolled session in the local space. An exact
  session ID wins; otherwise one case-insensitive name match is required.
  Ambiguous names list the candidates. Unknown names and unsupported spaces fail
  before storage. The whole selector is tried as a local ID or name first,
  including names containing `/`. If no local match exists,
  `"space/name-or-session-id"` qualifies the space; only the local space works.
- On Cotal, every successful send returns `deliveryStatus: "stored"`, `sequence`
  and `cotalId`. This proves broker storage, not delivery to the target. It carries
  neither `deliveredAt` nor `queuedAt`. A storage-outcome-unknown error must not be
  retried automatically: a resend can show the message twice.

## Native mesh operation safety

For each direct native mesh send, generate and retain a unique `operation_id`
before calling the official `agent_message.send`. The ID must be nonblank,
contain no ASCII control characters, and be at most 128 UTF-8 bytes. Use it only
for that exact logical message, target and text. Broadcasts, local sends and
Cotal sends do not accept this parameter; omitting it preserves existing send behavior. If the
outcome is unknown, first inspect or reconcile the original operation through a
documented, supported interface. A controlled retry of the same logical send is
permitted only under the official contract when the broker's durable
deduplication still applies, the target and payload are exactly unchanged, and
the same operation ID is used. Never blindly resend, change target or operation
ID, or automatically replay an old session or quarantined record. If these
conditions cannot be established, do not retry. Report any unresolved outcome
as unknown.

Do not directly write, modify, forge or simulate native journal, outbox or
marker files (including `native-mesh-operations`). Never manually construct an
`nm1m` filename or use a custom helper to bypass the official API.

Never directly modify broker SQLite data, delete messages, manually change or
forge ACKs, or fabricate read receipts. Never manually purge, clear, or reset a
queue, or bypass normal persistence to remove pending messages. Let the official
worker/supervisor flow ACK naturally only after the worker has actually persisted
the message. An anomalous or audit-mismatched ACK is not evidence of delivery
or reading; preserve it for controlled reconciliation through supported
interfaces. Do not manually ACK or blindly resend the message. The controlled
same-ID retry conditions above remain applicable only when every condition is met.

These instructions are advisory, not a security boundary. They cannot replace
OS identity isolation or daemon-side authentication, authorization and
protection of native message state.

## Safety

- Do not delete a child immediately after `send`: delivered follow-ups may still
  be running and queued receipts have not run yet. Wait until observation shows
  the child is idle and its context is no longer needed before calling
  `await rlm.delete_subagent(child)`.
- Role shortcuts and `"all"` remain limited to parent, siblings, and direct
  children. Name-only addressing reaches any local-space session on Cotal.
  Name-only sends require `agentMessageTransport: "cotal"`. With native messaging,
  send by family role.
- The `agent_message` API derives sender identity in the daemon. With Cotal, any
  same-OS-user process that can read the mesh files can act as the mesh signer.
  See "Mesh Agent Messaging" in the Prime Agent docs (`docs/daemon.md`).
- The daemon enforces message size, rate, and pending-queue limits before
  accepting delivery.
