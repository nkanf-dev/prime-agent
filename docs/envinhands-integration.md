# EnvInHands sidecar integration: investigation and next steps

Status: **experimental opt-in heartbeat adapter; cross-machine messaging is not implemented or verified.**
This note examines Prime Agent `0.9.8+fork.4` at commit
`4a32c06b3197bb24ae4d18be5c15801392d6b1c1` and EnvInHands prototype
`1d48aac08ca27ff886bf46c41e6eef4da62c02b8`. It does not change an installed agent.

## Verified interfaces and boundaries

* Prime Agent's `packages/coding-agent/src/core/extensions/types.ts` declares
  `ExtensionAPI.on()` hooks including `session_start`, `session_shutdown`,
  `agent_start`, and `agent_end`. These are possible lifecycle observation
  points, not proof of delivery or complete activity coverage. See
  `packages/coding-agent/examples/extensions/README.md` for extension loading.
* EnvInHands `src/control.ts` exports `createControlHandler()`. Each handler
  owns separate in-memory maps; restart loses state. Its implemented routes
  register and list machines, record heartbeat receipt time, and create/list
  resource messages. It has **no Agent activity endpoint**, authentication,
  authorization, TLS, or durable shared store. A heartbeat is not an SSH or
  Agent-health check. A resource message is not a lock or reservation.
* The prototype has no complete Prime Agent cross-machine message flow.
  Prime Agent's local agent-message facility is not evidence of one.

## Local-only verification

From an EnvInHands checkout at the commit above, with Bun and dependencies
already installed:

```sh
cd /home/nkanf/projs/envinhands
/home/nkanf/.local/share/envinhands/bin/bun test
/home/nkanf/.local/share/envinhands/bin/bun run typecheck
```

On this machine these passed: 42 tests, zero failures, and `tsc --noEmit`.
`test/control.test.ts` starts loopback HTTP servers and exercises registration,
heartbeat and messages; it also verifies separate handlers do not share state.
These tests do not exercise Prime Agent integration, remote hosts, or security.
The absolute paths above describe this machine only; use your own checkout and
Bun executable elsewhere.

## Original design notes

1. Add an explicit, opt-in Prime Agent extension and local EnvInHands sidecar.
   Define a small, versioned activity API in EnvInHands before connecting them;
   do not overload the existing machine-heartbeat endpoint with Agent status.
2. Start with only lifecycle event type, explicitly configured machine ID,
   opaque session ID, and observation timestamp. Do not transmit prompts, tool
   inputs/outputs, environment variables, credentials or full session logs.
3. Specify consent, payload limits, timeouts, failure handling, expiry and
   shutdown behavior. The adapter must not block or fail the Agent when the
   sidecar is absent. A missing or stale observation means unknown, not idle.
4. Test hook-to-sidecar delivery on loopback, failure and restart behavior,
   and secret exclusion before calling it integrated. Require authenticated,
   encrypted transport, identity and persistence before attempting multi-host
   use; test with two actual machines separately. Never expose the current
   unauthenticated control handler on an untrusted network.

The lifecycle hooks and EnvInHands routes above are source observations, not a
compatibility guarantee. The runnable adapter below targets a separately supplied
API, not the prototype.

## Experimental Prime Agent heartbeat extension

`packages/coding-agent/examples/extensions/envinhands-heartbeat.ts` is an opt-in
extension, not a built-in feature. It expects a separately configured API that
implements `POST /v1/agents/heartbeat` with bearer authentication and the JSON
contract `{agentId, machineId, task?}`. The earlier EnvInHands prototype described
above does **not** provide that API. Starting this extension alone does not add it.
Do not expose the unauthenticated prototype on an untrusted network.

Set all four variables before starting a **new** Prime Agent process, then pass
`--extension` (replace the paths and values). This does not modify an installed
agent. Use distinct, non-secret opaque IDs, not names, paths, prompts or tokens.
Use a token provisioned by the API operator; do not paste it into logs or chat.

```sh
export ENVINHANDS_URL=http://127.0.0.1:8787
export ENVINHANDS_AGENT_ID=agent-example
export ENVINHANDS_MACHINE_ID=machine-example
# Set ENVINHANDS_TOKEN securely in the environment, without saving it in a script.
./prime-agent.sh --extension packages/coding-agent/examples/extensions/envinhands-heartbeat.ts
```

Absent or invalid configuration disables the extension silently. The URL must
be a root origin without credentials, query or fragment. Plain HTTP is restricted
to localhost/loopback; other hosts require HTTPS. This URL validation is not a
substitute for securing the server, verifying its identity and authorization,
or a security audit. Protect environment access and use appropriate server-side
logging rules because the bearer token is an HTTP authorization header.

At session start, agent start, agent end and session shutdown the extension sends
a best-effort heartbeat with a fixed lifecycle string in `task`; every 30 seconds
while the session is active it sends a heartbeat without `task`. It never copies
an event, prompt, tool data or environment into the payload. The only data are
the explicitly configured IDs and these fixed strings. Requests time out after
2 seconds, refuse redirects, are limited to four in flight and are not awaited
by hooks; failures are silent. Shutdown delivery is not guaranteed, requests can
arrive out of order or be dropped, and a heartbeat is not evidence of health,
current state, receipt of a previous event, or a live machine. The service must
apply expiry and should interpret missing observations as unknown.

There is no implementation of listing agents, message send/receive, automatic
injection or acknowledgement. No cross-machine delivery or ack semantics have
been tested; do not infer them from this extension. Automated tests below use a
loopback mock, not a real network or a production service:

```sh
bun test scripts/envinhands-heartbeat.test.ts
```
