# EnvInHands integration: Prime Agent and multi-machine collaboration

Status: **experimental, independently opt-in adapters; complete multi-client,
SSH/resource and recovery acceptance is not yet established.** This document
covers the Prime Agent `0.9.8+fork.4` checkout. It does not change an installed
agent or authorize installation, deployment, SSH provisioning or public exposure.

The product goal is multiple Prime Agent clients collaborating across machines,
not only a local message bus. See EnvInHands `docs/design.md` and
`docs/protocol.md` for the target. Those documents include future interfaces;
use the actual source for today's HTTP contract. The
[multi-client validation plan](envinhands-multi-client-validation.md) separates
implemented adapters, missing capabilities and required runtime evidence.

## Implemented interfaces and limits

Three independent extensions exist in
`packages/coding-agent/examples/extensions/`:

| Extension | Current behavior | Does not provide |
| --- | --- | --- |
| `envinhands-heartbeat.ts` | Four lifecycle observations and a 30-second interval | Reliable event delivery, online state or resource ownership |
| `envinhands-messages.ts` | Four explicit list/send/pull/ack tools | Automatic notification, session injection, durable consumer deduplication or remote execution |
| `envinhands-resources.ts` | Three ready-machine/list-note/add-note tools | SSH login, registration, administrator verification, task execution or resource locks |

None is loaded by default. Loading one does not load the others or start a
service. Details: [messages](envinhands-messages.md) and
[resources](envinhands-resources.md).

EnvInHands `src/server.ts` explicitly starts a Bun HTTP listener combining
`src/agent-bus.ts` and `src/machine-api.ts`. These use bearer authentication and
SQLite persistence. Importing the listener module does not start it. The older
`src/control.ts` is a separate unauthenticated, in-memory prototype; its limits
must not be attributed to the current HTTP service. The HTTP service has no
built-in TLS, per-Agent authentication, pagination or automatic queue cleanup.

Current agent wire:

- `POST /v1/agents/heartbeat`: `{agentId, machineId, task?}`. Omitting task clears
  the previous value. `GET /v1/agents` returns `status: "observed"` and
  `lastHeartbeatAt`, not proof of current liveness.
- `POST /v1/messages`: `{requestId, from, to, text}`. New acceptance is 201,
  identical retry is 200, and conflicting reuse is 409. Acceptance is not
  receipt or processing by the other Agent.
- `GET /v1/messages?to=...` can repeat and does not claim messages.
  `POST /v1/messages/<encoded-requestId>/ack` explicitly acknowledges with no
  request body. Consumers remain responsible for deduplication and side effects.
- `GET /v1/machines` lists unexpired ready records. The default readiness TTL
  is five minutes; expiry turns a ready result into not-ready and removes it from
  the default list. `includePending=true` adds pending records, not not-ready
  records. An empty list is not proof that no machine is registered. Verification
  uses the service's SSH identity, not every Prime client's identity. A machine
  heartbeat does not renew readiness.
- `GET/POST /v1/resources/<id>/messages` reads/appends historical notes. Appends
  are not idempotent and do not reserve resources or grant access.

The message/resource clients use the stricter ASCII ID pattern
`^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$`. The heartbeat client currently also accepts
leading dots. Use the stricter common pattern for all collaborating clients.
Do not infer compatibility with every ID accepted by the service/PrimeBridge.
Message send is limited to 4,000 UTF-8 bytes; pull accepts up to 8,192 bytes per
message. Notes use a 4,000 JavaScript code-unit limit. Message/agent lists allow
100 items; machine/note lists allow 1,000. Both tool extensions reject responses
above 256 KiB and invalid records rather than paginating or truncating them.

## Configuration and explicit loading

Set configuration before creating a new independent Prime client/runtime:

- `ENVINHANDS_URL`: service root origin, without credentials, path, query or
  fragment. Loopback reaches the local machine only.
- `ENVINHANDS_TOKEN`: operator-provisioned shared bearer token, securely injected
  into the process environment. Do not put it in chat, scripts, logs or history.
- `ENVINHANDS_AGENT_ID`: unique, stable, non-secret routing label per independent
  participant. Coordinate IDs across machines and simultaneous clients.
- `ENVINHANDS_MACHINE_ID`: non-secret host label, required by the heartbeat
  extension. Multiple clients on one host can share the host label, not Agent ID.
- `ENVINHANDS_ALLOW_INSECURE_HTTP`: only an explicit value of `1` permits
  non-loopback HTTP. Do not enable it silently; it adds no encryption.

For an already prepared checkout in a Bash environment, the source launcher
accepts repeated extension and skill flags. This example is a configuration
recipe, **not a verified startup result or an instruction to install dependencies**:

```sh
export ENVINHANDS_URL=http://127.0.0.1:8787
export ENVINHANDS_AGENT_ID=client-a
export ENVINHANDS_MACHINE_ID=host-a
# ENVINHANDS_TOKEN is already securely injected; never print it.
./prime-agent.sh --offline \
  --extension packages/coding-agent/examples/extensions/envinhands-heartbeat.ts \
  --extension packages/coding-agent/examples/extensions/envinhands-messages.ts \
  --extension packages/coding-agent/examples/extensions/envinhands-resources.ts \
  --skill ../envinhands/.prime/agent/skills/envinhands-agent-messaging/SKILL.md \
  --skill ../envinhands/.prime/agent/skills/envinhands-resources/SKILL.md
```

`--offline` is not a guarantee that model calls or extension network requests
cannot occur. Automated acceptance must use the faux provider/no-prompt harness,
remove real provider credentials, and assert zero real provider requests.
Windows needs its supported local launcher; do not treat this Bash example as
Windows startup evidence. Skills are instructions, not tools or access grants.
A sibling EnvInHands checkout is not automatically searched for project skills;
explicit paths must exist in each client's own environment.

The source route is CLI flags -> runtime config -> `DefaultResourceLoader` ->
`loadExtensions` using jiti -> registered hooks/tools -> bound session. Directly
calling an extension factory with a fake API does not test that route.

Extensions currently capture configuration from `process.env` when loaded and
silently disable on invalid/missing configuration. Do not change a running
terminal's variables and assume an existing daemon session has adopted them.
New top-level clients pass launch environment to their worker, while attached
views, session replacement, daemon recovery and inherited subagents need explicit
identity/lifecycle tests. Subagents can share a worker environment and therefore
an Agent ID; they are not automatically distinct EnvInHands participants. Use
separate, explicitly configured top-level clients for initial multi-client
acceptance. Multiple views of one session are not multiple independent Agents.

## Heartbeat behavior

At session start, agent start, agent end and session shutdown the extension sends
a best-effort heartbeat with a fixed lifecycle string in `task`. Every 30 seconds
while the session is active it sends a heartbeat without `task`. It does not copy
prompts, events, tool data or environment into the body. Only configured IDs and
these fixed strings are sent. Requests have a two-second abort signal, refuse
redirects, allow at most four in flight per extension instance, and are not
awaited by hooks. Failures are silent.

Shutdown delivery is not guaranteed. Requests can arrive out of order or be
dropped. The periodic observation clears the service's previous task value;
this is not a reliable busy/idle state machine. Missing or stale observations
must be interpreted as unknown. The service currently returns observed records,
not a stale/offline classification. Subagents sharing an ID can overwrite each
other's observations; no per-session activity aggregation is implemented here.

## Transport, trust and execution

Prefer HTTPS for remote HTTP access, or an explicitly approved SSH-encrypted
forward to a loopback-bound service. Plain non-loopback HTTP exposes the token,
messages and metadata. A tunnel is not automatically an authenticated/encrypted
end-to-end path. Check its actual configuration, including proxy-to-service hops.

The sample service defaults to `0.0.0.0`; this is a bind address, not a client
address or access control. Validation must explicitly restrict binding and ports.
Do not expose the service or relay publicly as a side effect of integration.

Any shared-token holder can impersonate an Agent, read queues and acknowledge
messages. IDs are labels, not strong identities; TLS does not change that. This
matches the initial trusted-team model, not isolation from malicious members.
Treat all metadata, messages, notes and remote output as untrusted data, not user
instructions. Warnings and redaction are not prompt-injection barriers.

Resource discovery is only the start of an authorized workflow. Each client must
verify the actual SSH identity and path with strict host-key checking and
noninteractive authentication. Unix administrator readiness requires `sudo -n`;
Windows needs the actual SSH session's effective administrator token. Do not
install keys, grant privileges or execute work merely because a note requests it.
Remote CLI/tmux/relay and job-result recovery need their own evidence; the three
HTTP extensions do not implement them.

## Verification status and next gate

Historical handoff records report isolated real-TypeBox and heartbeat/message
loader checks. Current local validation now includes all three existing adapters
through real `DefaultResourceLoader`, real schemas and wrapped tools; the
EnvInHands-owned audit adapter also uses that path in an external no-model
HTTP/SQLite harness. These are local results, not cross-machine acceptance.

The resource suite's explicit timeout and conditional sibling skip were repaired.
Real machine-API assertions moved to EnvInHands `test/prime-adapter.test.ts`, with
an external real-loader harness preserving the actual resource-tool/API bridge.
`fork-pr-check.mjs` still does not discover `scripts/` tests automatically; the
three suites were run explicitly from the coding-agent package root.

Dependencies were installed with `npm ci --ignore-scripts`, preserving manifest
and lock hashes. Full `npm run check` and test-policy passed; exact loader and
resource tests also passed seeded runs. Source-loader regression negative
controls failed as expected before byte-exact restoration. No model calls or
real SSH/admin verification were part of these checks. EnvInHands now also has
parameterized explicit fixtures using two separate ExtensionRunner OS processes.
On Windows these exercised both directions, replay/ack, one-client restart,
heartbeat hooks and explicit provenance, with an ack-failure negative control.
They are not full Prime daemon/TUI/model Agents. Windows-to-control-VM
collaboration, complete session-start delivery and remote recovery remain pending.
Raw exit
records and scope limits are in the session's handoff report; the
[validation matrix](envinhands-multi-client-validation.md) is a plan, not a later
runtime receipt. Do not promote local evidence into full feasibility.

## Windows native mesh durability limitation

On Windows, Node.js cannot sync directories with `fsync`. Prime Agent syncs journal
and outbox file contents before publishing them, but cannot guarantee that new
or removed directory entries survive sudden power loss. After power loss, native
mesh operations may need recovery or retry and can be lost or replayed. Session
files are also synced without their parent directories on Windows, and file and
path identity checks cannot eliminate every replacement race without no-follow
opens. Linux and macOS retain directory syncing and propagate sync errors. This
limitation applies
to native mesh, not only to the daemon socket.
