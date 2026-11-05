# EnvInHands sidecar integration: investigation and next steps

Status: **design only; no adapter or cross-machine messaging is implemented here.**
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

## Proposed minimum adapter (not yet implemented)

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
compatibility guarantee. This note intentionally does not provide a runnable
adapter until its endpoint and security contract exist.
