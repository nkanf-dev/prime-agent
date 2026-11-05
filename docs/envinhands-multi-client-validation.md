# Prime Agent: EnvInHands multi-client feasibility and acceptance

Status: **inspection and acceptance plan, not a passed integration report**.
Baseline: Prime Agent `0.9.8+fork.4`, HEAD
`e398494ebbe70168f0bc15cef8e8c6810d9b2f74`. This review used the current local
EnvInHands source and its `docs/design.md` / `docs/protocol.md`; uncommitted
owner changes must be included in any later source manifest.

The findings below describe the pre-implementation inspection snapshot, not
an up-to-date failure list. The subsequent implementation receipt in the handoff
evidence directory records locked dependency installation, source-loader and
Windows test-runner fixes, repaired resource policy, real wrapped-tool local
HTTP/SQLite tests and seeded passes. Remaining cross-process/cross-machine work
must not be inferred complete from that local receipt. New audit adapter/client
business code belongs to EnvInHands, not the Prime platform.

## 1. Delivery objective and control host

Multiple independent Prime Agent clients must collaborate across machines and
help validate the complete EnvInHands workflow: discovery, identity-specific
access, authorized remote work, messages, experience, failures and recovery.
Local HTTP enqueue, generic Bridge tests, same-daemon agent messages or two
attached windows do not establish that objective.

The current control host is the Hyper-V **EnvInHands-Debian12** VM. It may host
control APIs, the message bus and relay for final integration acceptance of the
implemented scope. It is not necessary to replace it with a NAS before that
acceptance. Intel NAS hardware, Linux desktop, three Macs and real separate
networks remain additional compatibility/coverage targets, not assumed passes.

Initial target topology:

```text
Windows: independent Prime client A
  unique agentId, its own runtime/session and actual SSH identity
            |
  approved strict-host-key SSH encrypted forward
            |
EnvInHands-Debian12 control VM
  loopback-only bus + temporary SQLite DB
  independent Prime client B with a different agentId
  relay/node/proxy in separately authorized scenarios
```

Client B may use the VM's machine label because it runs there; A uses its own
host label. Multiple clients on one host share machineId but need distinct
agentId labels. Run a later same-host two-client case as well as the two-host
case. Shared bearer labels are **not** per-Agent authenticated identities or
security isolation. The initial product trusts team members; it does not require
a new internal role/tenant system before testing, but SSH identity and external
network security cannot be omitted.

VM role approval does not prove runtime installation, service deployment or
administrator readiness. The coordinator reports strict SSH login works but
`sudo -n` fails. Client B's own SSH identity has not been established. Preserve
these negative results; do not install keys or change sudoers to turn them green
without separate approval.

## 2. Inspection findings and release blockers

| ID | Source observation | Impact / required closure |
| --- | --- | --- |
| P1 | `scripts/envinhands-*.test.ts` directly calls extension factories with a constructed API. Only the resource suite imports real TypeBox validation. | Exercise real loader, schemas, bound tools and lifecycle for all three in the target checkout. A fake factory registration is not runtime acceptance. |
| P2 | `scripts/envinhands-resources.test.ts` has an explicit timeout and conditional sibling-checkout skip. `check:test-policy` exits 1. The message suite also has a wall-time timeout test, grandfathered relative to the current policy baseline. | Make touched suites deterministic and self-contained. Do not weaken policy or hide failures by changing the baseline. Do not modify tests until their required direct execution can be completed. |
| P3 | `fork-pr-check.mjs` executes changed tests only under `packages/<pkg>/`; root tsconfig includes package source/tests/examples, not scripts tests. | An exit 0 from this script is not evidence that the three adapters ran. Use package-owned tests or explicitly documented direct Bun runs; follow package-root and changed-test rules. |
| P4 | All three adapters capture `ENVINHANDS_*` from process environment during loading. `DAEMON_CLIENT_ENV_KEYS` contains HERDR variables, not these keys; new top-level launchEnv is passed separately to a worker. | Do not diagnose daemon startup solely from the allowlist. Test fresh A/B launches, omission, attachment, reload, fork/subagent and recovery through the real launch route. Never print env or tokens. |
| P5 | Supervisor worker environment merges supervisor env with launchEnv; omission of a key does not explicitly unset an ambient supervisor key. Subagents inherit a worker/client environment. | Test ambient-value inheritance and duplicate Agent IDs. Independent launch environments may work, but absent config must not silently reuse another participant's ID/token. This is a static risk, not a reproduced runtime failure. |
| P6 | Heartbeat does not derive an ID from sessionId, and inherited children can load the same configured adapters. Task updates are best effort, may reorder, and interval calls omit task. | Define child aggregation vs distinct-participant policy. Until tested, use independent top-level clients and do not count children as distinct remote Agents. Detect ID collisions operationally; do not auto-generate unstable retry identities. |
| P7 | Resource tools only list machines/read notes/add notes. No task/job ID, SSH execution, administrator evidence or result-recovery tool exists in these adapters. | Validate authorized SSH/CLI execution separately, using each client's actual identity, path, exit status and task evidence. Catalog presence cannot establish project feasibility. |
| P8 | Service/PrimeBridge accept wider IDs, for example `request/1`; actual Prime message tools reject slash IDs, including a whole pull response containing one. Client capacities are narrower than unbounded service lists. | Keep common IDs in integration fixtures; separately prove explicit safe rejection. Require an operational overflow/retention plan, without silently changing wire limits or blindly acking to empty a queue. |
| P9 | EnvInHands skills are project-local to the sibling checkout. This Prime checkout has no corresponding bundled EnvInHands skills. | Explicitly load the two SKILL.md paths on each participant, or use an agreed packaging route. Prove discovery from an unrelated workspace and correct relative CLI paths; reading a skill is not execution proof. |
| P10 | Local node_modules and package dist entrypoints are absent. Source jiti aliases refer to package `.js` entrypoints; packaged and source loaders use different resolution paths. | Validate the selected source/package artifact with real dependencies. Do not assume installing alone fixes aliases, do not substitute installed G-drive code, and do not run the forbidden build to bypass a failure. |
| P11 | Adapters silently disable on invalid config and have no connection/readiness/status diagnostic tool. They do not subscribe/poll/inject messages automatically or persist a consumer inbox. | First release may use explicit pull, but must prove real calls are reachable and disabled state is diagnosable. Durable consumer-side deduplication, bounded notifications and automatic collaboration remain separate work, not implied features. |
| P12 | No complete automatic, Agent-signed audit trail for all local/remote resource modifications is implemented. Resource notes are non-idempotent and share spoofable author labels. | Add registered-Agent/session provenance and verifiable operation records across the actual mutation paths. Manual logs are an interim, explicitly bounded measure, not proof of automatic coverage. |

No daemon wire or extension input limit was changed by this inspection. If a fix
needs a daemon command/event/response-shape change, classify compatibility and
follow capability/version/schema/old-new tests in AGENTS.md. Do not add an
ungated startup dependency or alter CI as a side effect.

## 3. Runtime acceptance matrix

Every row needs its own source/runtime versions, command or harness entry,
observations, exit codes, negative control and remaining limits. **All runtime
rows below are pending for this checkout** unless a separate dated receipt says
otherwise. Historical Linux passes are historical, not current evidence.

| Stage | Must demonstrate | Failure / falsification case | Owner |
| --- | --- | --- | --- |
| L0: reproducible baseline | Current source hashes including owner edits, runtime/platform and lock hashes; approved frozen install with scripts disabled; full required checks and exact changed tests | First install/check failure preserved; manifest/lock mutation or hidden scripts fail the gate | Each repo owner; coordinator supplies portable runtime |
| L1: real loading, no model | Actual `DefaultResourceLoader`/jiti, heartbeat handlers, exactly four message and three resource tools; real TypeBox schema validation; two skills loaded from explicit paths | Absent/invalid config registers no network tools; missing file/import fails visibly; remove a registration or break schema and test must fail | Prime |
| L2: independent clients | Separate processes/runtimes A/B, distinct IDs and sessions, same service; no cross-client identity/token contamination; same-host extra client; attachments are views | Conflicting/missing/ambient IDs, restart one client, inherited child and reload do not silently masquerade as a distinct Agent | Prime |
| L3: real bus over loopback | Temporary DB and random ports; actual loaded tools perform discovery, lifecycle observations, A-to-B and B-to-A send/pull/ack | No/wrong token 401; compatible-ID boundary; service unavailable, bad JSON, redirects and cancellation fail without leaking credentials or acking | Both owners |
| L4: replay and restart | 201/200/409 observed at service boundary; identical tool send retry; repeated pull; explicit repeated ack; pending/acknowledged IDs survive restart using same temporary DB | Drop response after durable send; crash after handling before ack; consumer deduplication prevents repeated fixture side effect; unknown sends retain same ID/content | Both owners |
| L5: real two-host collaboration | Windows A and VM B use their own actual Prime load/runtime and safe encrypted route to VM service; all message/resource tools exercised bidirectionally; no paid model calls | Stop A/B independently, interrupt only owned connections, restart bus; other queues remain intact; stale heartbeat is not reported online | Prime + coordinator |
| L6: usable resource, not just a record | Current client's strict host-key/BatchMode login over actual selected path; Unix sudo-n or real Windows effective admin-token result; show service vs client verification scope/time | Service identity succeeds while client identity fails; wrong/changed host key; expired evidence; current VM sudo failure remains not-ready | EnvInHands + coordinator; Prime drives approved probes |
| L7: resource notes and capacities | Correct resource association, author/time, trimmed write result, restart persistence; duplicate note risk visible; 4000-byte send/8192-byte pull/code-unit notes, 100/1000 counts and 256 KiB bound | Lost note-write reply is unknown, not blind retry; oversize/poisoned-ID lists fail without truncation or ack; malicious text never becomes authorization | Both owners |
| L8: actual remote work | Authorized harmless task on remote machine, target identity/path, unique task/evidence reference, observed exit code/result and cleanup; consumer result reply distinguished from enqueue/ack | Disconnect while task runs: mark outcome unknown; do not repeat non-idempotent work; independent result query required | Both owners + coordinator |
| L9: relay/new-connection recovery | Real node outbound path, proxy SSH flow, wrong secret/missing node/host key rejection, restart, bounded backoff and explicitly stopped reconnect test; bounded data/slow reader/EOF tests | No transparent old-SSH migration; unsupported half-close reported, not claimed delivered; current automatic multi-backend probing/fallback is not implemented | EnvInHands + coordinator |
| L10: persistent session | Unix real PTY/tmux unique session, disconnect/re-attach same surviving process; missing tmux, double attachment and host reboot clearly distinguished | CLI argv tests or non-TTY invocation cannot prove attach; Windows native tmux not assumed; do not kill others' sessions | Coordinator + EnvInHands |
| L11: auditable modifications | Every actual local/remote modification has Agent/session registration reference, machine/resource, operation, authority, time, outcome and evidence; failures/partial/unknown states included | Missed filesystem/config/dependency/DB/deployment mutation or secret-bearing record fails coverage; retained records survive client/service restart | All owners; product implementation shared |
| L12: remaining target coverage | Intel NAS, Linux desktop, Windows host behavior, each of three Macs, actual separate networks/NAT and encrypted service/relay routes; concurrent load and backup/restore | VM Default Switch is not Internet/NAT proof; one OS/hardware is not all six; two common-failure-domain routes are not independent failover | Coordinator + both owners |

Current node reconnect continues until explicitly stopped, with a capped
exponential backoff delay and jitter. A total retry-count/time budget is not
implemented; deciding such a budget is separate from validating bounded backoff.

L5 on the current VM can establish the implemented collaboration slice; it does
not close missing registration/provisioning, per-identity evidence, task-result,
path-selection or audit features. Full feasibility requires either implementing
and validating those requirements or a user-approved explicit scope change.

## 4. No-model test route and permitted preparation

After explicit dependency/runtime permission, the first Prime test route should
use the checkout's existing `packages/coding-agent/test/resource-loader.test.ts`
and `test/extensions-runner.test.ts` patterns. Load the real three adapter files
with temporary agent/workspace settings and real TypeBox. Bind hooks and tools
through the real runner/session interface; prove registration first, then invoke
observable tool behavior. Do not create a fake TypeBox or replace the loader with
a factory call and call it equivalent.

For process/session behavior use `test/suite/harness.ts` and its faux provider.
Drive deterministic scripted tool calls with no real model credentials or
requests. Where the real public RPC lacks a direct arbitrary-tool invocation,
use the native test/session API rather than inventing an RPC command or prompting
a paid model. Loader-only and faux-provider runs must still be labeled distinctly
from a human/real-model collaboration trial. `--offline` alone is not a guard
against model calls. No paid trial is authorized by this plan.

Each process gets explicit local paths, a dedicated temporary data directory,
compatible IDs and a random test token held in process memory/environment. Avoid
shared mutable process.env tests as a substitute for process isolation. Await
actual server/listener completion signals and close resources in finally.
Use port 0 for fixtures. Cross-host SSH forwarding needs a coordinator-owned,
observably ready endpoint, not a fixed sleep or a public bind. Do not dump env,
auth headers, prompts, request text or real business databases.

Follow AGENTS.md: no `npm run dev`, `npm run build` or `npm test`. After code
changes run full `npm run check`, `npm run check:test-policy`,
`node scripts/fork-pr-check.mjs` and applicable exact tests from their package
root. Modified tests need direct runs and falsification; concurrency/order work
also needs shuffle seeds 17, 43 and 101 without retry-to-green. A test-only change
must remove at least as many lines as it adds. Do not bypass scripts coverage by
using an empty changed-package-test result. Documentation-only changes do not
require the code check; they still need accurate source review and diff checks.

## 5. Modification provenance requirement

Every Agent modification of a local or remote resource must leave a traceable
record outside chat and Git commit prose. Record at least:

- registered stable Agent ID/reference and local session ID; distinguish a local
  declared ID from an actually registered or authenticated identity;
- execution machine, target machine/resource and unique operation reference;
- actual time where known, record time, action, non-sensitive summary/reason and
  the exact authorization source/scope;
- success, failure, partial or unknown outcome, plus before/after hashes when
  available and links to raw evidence;
- whether an entry is retrospective, which times/hashes are unknown, and the
  difference between command acceptance and observed durable effect.

Coverage includes uncommitted files, configuration, dependency installation,
deployment, database writes, remote tasks and cleanup, not only source edits.
Do not record tokens, passwords, private keys or sensitive bodies. Include the
registration reference rather than copying a registration secret. Shared-token
署名/author labels are not cryptographic identity or tamper protection.

During this inspection, Prime keeps a manual, local-declared-agent, append-only
workflow record in the handoff evidence directory. It covers known session-owned
changes, with old entries marked retrospective and exact operation time unknown.
This is **not** automatic all-Agent or remote-resource audit coverage. The product
still needs a decided durable format/store, failure policy, operation correlation,
protected retention and coverage tests. A resource note may reference a change,
but its non-idempotent write and spoofable author cannot replace that ledger.

## 6. Implementation and continuation rules

Preserve the complete product objective during handoff and context compaction:
six devices, multiple independent Prime clients, each Agent's real SSH identity
and noninteractive administrator verification, actual NAT/multi-entry probing
and new-connection fallback, messages/experience, Unix tmux, and signed records
for all resource modifications. The current VM is the control host for final
integration acceptance, not a placeholder that must first be replaced. Do not
reduce completion to local bus or mock passes.

Keep responsibilities explicit and reuse existing loader, runner, HTTP clients,
SSH/CLI and test harnesses. Do not duplicate backend logic inside Prime, add
speculative defensive wrappers, preserve obsolete compatibility without a real
need, or silently fall back after a genuine failure. Decoupling is not permission
to remove strict host-key checks, credential protection, necessary input limits,
capability negotiation or honest error reporting. Ask before deleting intentional
behavior; record and directly validate the smallest authorized code change.

SSH login/forwarding can succeed even when sudo-n fails. Report the encrypted
channel and administrator readiness separately. Client B can run locally on the
control VM without an SSH identity merely to call the bus; any claim that B can
use an SSH resource still needs B's actual identity/path evidence. Bind the
Windows end of an approved forward to loopback and await a real readiness signal.

## 7. Evidence and completion report

Use distinct evidence levels: source observation; unit/mock; real loader;
real process+HTTP+SQLite; two-host; multi-network/platform. Do not promote one
level into another. Save each first run/failure under a unique filename, keeping
full stdout/stderr and actual exit_code. Record operation/fixture IDs instead of
sensitive content. Include platform/runtime/artifact hashes, source and target
machine labels, SSH public identity reference, route, timestamps, restart/boot
reference where relevant, result and limitations. A later pass does not erase a
failure. Only clean up resources owned by that test.

Completion should separately answer: can independent clients find and message
each other; can each actually access and execute approved work on the resource;
can failures recover without duplicate side effects; are modifications traceable;
which target requirements remain absent? A single green bus test answers none
of the remaining questions automatically.
