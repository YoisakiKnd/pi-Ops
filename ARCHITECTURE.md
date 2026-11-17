# Architecture

## Current scope

pi-ops is a Pi Agent extension with project-scoped Markdown memory and scheduled
Agent tasks. A small independent Node scheduler survives closed interactive
terminals and launches Pi SDK sessions in isolated worker processes. The same
elected process owns Telegram polling and topic routing for live Pi sessions. HTTP
probes are an additional task type. Cron and richer Telegram controls remain later
stages.

```
Pi ops_schedule ─┐
              ├── task commands ── schedule.db
CLI ──────────┘                       ▲
                                     │
                         one elected broker + scheduler
                                     │
                        Pi SDK workers / HTTP probes
                                     │
                        runs → incidents → notifications
```

## Project identity

`projectFor(cwd)` resolves symlinks and derives an ID from the canonical absolute
path plus a readable folder name. Two unrelated directories named `app` therefore
have separate memories and tasks. An explicit `.pi-ops.json` file in the working
directory, containing `{"projectId":"payments"}`, gives a stable identity across
moves and machines. Sharing an explicit ID intentionally shares its scope.

This does not search parent directories or infer Git repository roots. Users should
run Pi and the CLI from the intended project root. Changing IDs changes the visible
scope; it does not move old data automatically.

Legacy folder-name memory is retained. `/memory import-legacy` copies facts from
the old scope to the current project, preserving dates and tags. It is explicit
because automatically adopting a same-named project's facts would defeat isolation.

## Memory

Markdown is authoritative; SQLite FTS5 is a disposable derived index. Each fact has
a deterministic ID based on scope, date and canonical body. Writes parse their own
Markdown representation so saved IDs agree with IDs recovered after a rebuild.

| Scope | File |
|---|---|
| `global` | `memory/global.md` |
| `project:<id>` | `memory/projects/<id>.md` |
| `event:<id>--<YYYY-MM>` | `memory/events/<id>--<YYYY-MM>.md` |

Recall includes the current project's facts, its dated events and global facts.
Unassociated legacy monthly events are retained but not automatically assigned to a
project. Indexed and fallback retrieval apply the same scope rules.

Han runs are indexed as overlapping bigrams; Latin and numeric tokens stay whole.
Scores are relative to the best match. A bounded prompt section includes a staleness
warning and is removed when the next turn has no useful matches.

Index mutations and full rebuilds use transactions. Session start checks a file
fingerprint to detect edits. Cross-process memory edits during a running session
become visible at the next session start or explicit reindex.

## Scheduler ownership

Any eligible Pi process or detached daemon can bind `127.0.0.1:<port>` (default
43917). One raw TCP listener accepts newline-delimited JSON bridge clients and
multiplexes HTTP control requests to an internal HTTP parser. Binding is acquired **before**
recovering unfinished work. A second daemon on that port fails without changing
active run records. HTTP control requests use a random bearer token stored in the private
scheduler database. JSON bridge registration and subsequent frames authenticate
with that same local secret and protocol version. Startup verifies the service identity and token, rather than
assuming any occupied port belongs to pi-ops.

All schedulers sharing one state directory must use the same configured port.
Changing the port while an old daemon is running is unsupported; stop it first.
The database independently prevents overlapping runs of a task using an atomic
claim transaction and a unique partial index on `status='running'`.

Socket ownership alone does not guarantee exactly-once execution of external work.
HTTP probes execute in the daemon. Agent work executes in owned Node workers,
which load the installed Pi SDK and watch the parent IPC connection. Timeout or
shutdown first requests cancellation, then enforces bounded worker termination.
Worker loss is uncertain execution; Agent tasks are blocked until explicit resume.
Side effects cannot be rolled back by this protocol. Exactly-once external actions
are not promised, and actions must be reconciled before resuming.

## Durable state and scheduling

`schedule.db` is authoritative for tasks, runs, incidents and notification records.
It is separate from the deletable memory search index. Schema creation is idempotent;
SQLite WAL and transactions allow CLI/Pi commands while the daemon is checking.
Scheduling requires Node's SQLite support; memory can still fall back to a scan.

A task stores its kind, project ID, cwd, name, interval, timeout, failure threshold,
enabled/blocked state and next due time. HTTP specs contain URL and expected status;
Agent specs contain prompt, tool allowlist, turn limit and output bound. First run is one interval after
creation. Intervals use epoch milliseconds; no timezone or daylight-saving
interpretation is needed. Cron and wall-clock schedules are not yet implemented.

A scheduled claim atomically inserts a run and advances its next due time:

- Due within `schedule.misfireGraceMs`: execute once, collapsing missed intervals.
- Older than the grace window: record one `skipped` run and advance beyond now.
- Already running: do not overlap it.
- Paused: do not claim it automatically.

The daemon polls every second and runs at most four checks concurrently. Manual
runs use the same ownership and concurrency rules and do not change the periodic
schedule. An ordinarily paused task can be run manually. A blocked Agent task cannot; it
requires explicit resume after reconciliation. Resuming schedules the next check one
interval from now and resets its failure streak. Pausing does not cancel a check
already in progress.

Every run has a UUID, scheduled/start/finish timestamps, owner, state and structured
result. States include `running`, `success`, `failure`, `timeout`, `skipped`, and
`unknown`. On startup, unfinished runs become `unknown`; they are not silently
retried or counted as failures. Interrupted Agent tasks are additionally disabled
and blocked. Their progress metadata, including any transcript path, is retained.
Graceful shutdown aborts outstanding checks and workers, waits
for their records to finish, then closes the listening socket and database.

## Pi Agent execution

`ops_schedule` lets the interactive Pi Agent save a recurring prompt in the current
project and launch the scheduler. `/ops agent-add` provides a manual equivalent;
CLI task management uses the same store. No scheduler starts just because Pi loads
the extension. Scheduled tasks use independent Pi sessions. Telegram replies target the registered
live session, or resume its exact saved transcript when wake is explicitly enabled.

The engine dispatches `agent` tasks to `runAgent`, which forks `agent-worker.cjs`.
The worker imports the installed Pi SDK and calls the typed `executeSession` adapter:

1. Verify the saved cwd still resolves to the saved project identity.
2. Load normal project resources plus an explicit path to the Pi Ops extension.
3. Create a persistent `SessionManager` and `createAgentSession` with a tool allowlist.
4. Bind extensions so session hooks, memory scope and index preparation run.
5. Prompt with task/run metadata and the saved user instructions.
6. Capture final text, structured report and session identifiers; dispose the session
   and settle pending credential writes before returning the result.

The parent records session progress while the run is still active, applies an
independent wall-clock timeout, bounds stdout/stderr, and waits for worker exit
before committing completion. The SDK adapter bounds turns and streamed text.
Workers receive abort via IPC; parent disconnect also triggers abort. A hard deadline
handles extensions/providers that do not respond to cancellation. Forced termination
cannot guarantee cleanup of arbitrary external processes launched by tools.

The default tool set provides file inspection, memory search/save and `ops_report`.
Tasks can explicitly select additional tools; reporting remains available. These
are Pi tool permissions, not filesystem/process isolation. SDK sessions use Pi's
configured model/auth defaults. MCP/codemode CLI built-ins are not installed by this
adapter. Other user extensions and skills use standard SDK discovery.

Agent reports separate execution from observation. `status=success` means the Agent
finished; `outcome=healthy|degraded|unknown` describes the environment. Only degraded
observations count toward an incident, and only healthy observations close one.
Absent reports and provider errors cannot close an incident. All unsuccessful Agent
executions block that task, allowing the user to reconcile any partial operations
before resuming; they are not automatically retried.

## HTTP probes and incidents

Probes accept HTTP(S) URLs without embedded credentials, use bounded timeouts,
compare one expected status, and cancel the response body without buffering it.
Redirects are recorded as the returned 3xx status rather than followed silently.
Results record HTTP status (when available), duration and a bounded explanation.
A failed network check is evidence of failed availability from this machine; it is
not a diagnosis that the target process is down.

Three consecutive failures/timeouts open an incident by default. Success resets the
streak; unknown or skipped work breaks it. Further failures of an open incident do
not create repeated alerts. The first subsequent success closes the incident and
creates one recovery notification. A future regression creates a new incident.

Run completion, streak changes, incident transitions and notification creation
commit in one transaction. A unique `(incident_id, kind)` constraint prevents
duplicate opening/recovery notifications. Records include their project and the
incident's opening/closing run IDs for evidence lookup.

Durable records are available locally through
`ops events`, and new transitions are printed to the daemon's output (the
`scheduler.log` file when detached). The log is a convenience, not a transactional
delivery guarantee: a crash after commit can precede log output. Durable records
remain queryable. Configured Telegram delivery uses the durable TG outbox described
below. HTTP/Agent incident notices target the newest registered session for that
project, while Agent output follows its own session topic.

## Telegram leader/client transport

Reference: `JohnsonRan/pi-telegram-operator` at commit
`a9b444db4db0c95ab4d1eee8c86a122208b9d4b4`. The implementation is independent;
it retains the port-election, registered-client, topic-routing, queued-reply and
wake-daemon design. State is stored transactionally in the existing SQLite database
instead of the reference's JSON state file.

A Pi client registers its session ID, cwd, project ID, display name and transcript
path. A newer connection for the same session supersedes the previous client.
Messages from TG require both the configured chat ID and user ID. Accepted updates
advance the polling offset and insert their pending message in one transaction.
Only the leader polls TG. Clients acknowledge accepted prompts; delivery IDs are
also appended to Pi session entries to deduplicate reconnects.

Session topics are created lazily on first output, and their IDs persist across
leader changes. Live draft updates are throttled and ephemeral. Final assistant
text is recorded in the Pi transcript as a pending send, accepted durably by the
broker, then split into bounded Unicode-safe chunks. Retransmission uses stable
keys. An accepted marker is appended to the Pi transcript; SDK workers wait for
acceptance before exiting. Thinking and raw tool output are not forwarded.

Outbound states include pending, sending, sent, failed and uncertain. Rate limits
retry after the server's delay. A network-ambiguous send or leader loss during a send
remains uncertain; automatic retry could duplicate an already-visible message.
Topic creation has the same uncertain-state rule. The local `ops tg` commands expose
these states and allow explicit mapping repair or outbound retry.

The client recovery chain is direct connect → detached wake daemon → embedded local
leader fallback. `runWakeDaemon` waits and reattempts bind after `EADDRINUSE` or a
handover. Intentional stop is persisted in broker_desired, so reconnecting Pi clients
do not undo `/ops stop`. An explicit start re-enables it. Restart after an OS reboot
still requires launching Pi or the daemon; a user service can be installed explicitly with service.cjs.

Without wake, offline-session replies remain queued. With wake enabled, the broker
checks the canonical cwd against explicitly allowed roots and requires an existing
transcript. It reserves one pending message for that session and runs the existing
Agent worker with SessionManager.open. The worker registers the restored session
and streams output through the same bridge. Additional messages can steer that
connected session. Interrupted wake deliveries become uncertain, requiring user
inspection rather than automatic replay. Wake uses the inspection/memory tool
allowlist and bounded runtime by default.

Broker shutdown aborts the TG long poll, cancels wakes, drains active work and closes
client sockets before releasing the elected listener. Scheduling and TG are never
separate port owners. The current feature set covers text, streaming, `/stop`,
pending delivery, known-session wake, pinned control cards, attachment exchange and
`/new`. Single/multiple-choice question UI, HTTPS cloning and macOS/Linux user service
management are implemented; rich widgets and Windows services remain pending.

## Durable Telegram interactions

`tg_actions` stores authenticated callbacks, attachment messages and main-chat
commands in the same transaction that advances the polling offset. A serial action
processor records processing/done/failed/uncertain states. Interrupted actions are
not blindly re-executed. Stable update IDs deduplicate queue insertion.

`tg_cards` stores one card token and message ID per session, pin status, current
phase, dirty state and errors. Cards edit in place. Their opaque callback tokens fit
Telegram's 64-byte limit and must match the saved message ID, owner, chat and topic.
Pi lifecycle events update phase and retain the latest user prompt for Retry.
Controls insert normal durable inbox messages; Stop also cancels a starting wake
worker. Card creation is uncertain after an ambiguous send, with explicit local
card-bind repair.

Attachments are downloaded through getFile with a bounded streaming reader, then
saved atomically into a private, symlink-free project inbox. Only the resulting
caption/path enters the Agent prompt. Outbound files use a persistent typed outbox
row; their canonical paths and sizes are checked both at enqueue and upload, and
multipart upload happens inside the shared broker. The tool confirms queue
acceptance rather than claiming delivery success.

Remote `/new` reserves a UUID and topic before any model execution. `tg_remote`
tracks its source update and whether a transcript has actually existed. An initial
message starts SessionManager.create with that UUID; subsequent wakes open the
saved transcript. A failed startup without a transcript can be retried by a new user
message, while deletion of an established transcript does not silently create a
replacement conversation. Allowed roots are resolved before creating any session.

## Entry points

- `index.ts`: Pi tools, memory injection, `/memory` and `/ops` commands.
- `cli.cjs`: the same task command service outside Pi.
- `daemon.cjs`: wake/leader loop; `ops start` launches it detached.
- `setup.cjs`: hidden-token setup, one-time private-chat binding and topic verification.
- `src/telegram/`: authenticated bridge, transactional TG queues, polling and Pi hooks.
- `src/shared/project.cjs`: shared project identity rules.
- `src/schedule/store.cjs`: transactional task/run/incident persistence.
- `src/schedule/probe.cjs`: bounded HTTP checks and input validation.
- `src/schedule/agent.cjs`: worker ownership, cancellation and output/timeout bounds.
- `src/schedule/agent-worker.cjs`: isolated Pi SDK host and parent-disconnect guard.
- `src/schedule/agent-session.mjs`: typechecked SDK session, memory and reporting adapter.
- `src/schedule/engine.cjs`: claims, concurrency, execution and shutdown.
- `src/schedule/runtime.cjs`: socket ownership, authenticated control and startup.

## Next stages

1. Live interactive-session routing, per-task model selection and monetary budgets.
2. Cron schedules with explicit IANA timezones and documented DST behavior.
3. Rich Telegram widgets and Windows service support.
4. Memory provenance, verification age and supersession relationships.
5. Runbooks and evidence-based reports across projects.

## Questions, cloning and managed startup

`tg_questions` records stable tool request IDs, options, selected indexes, answers,
expiry and delivery acknowledgement. Question callbacks share the durable action
queue and require the original owner/topic/message. Multiple selections remain
open until Done. Client waiters survive bridge disconnects, replaying the same key
on registration; cancellation and expiry reject the original tool. This does not
recreate a waiting tool after a full Pi process restart.

HTTPS clones reserve a new directory under the canonical allowed default root. Git
uses an argument array, noninteractive credentials, disabled hooks/global config,
restricted transport and no redirects. There is a two-minute deadline. Failures
retain the reserved directory, and interrupted actions are not automatically
replayed. A successful clone enters the existing remote-new-session path.

`service.cjs` renders or installs a launchd LaunchAgent or systemd user unit with
private atomic files. Dry-run does not write files or call a service manager. In
managed mode the daemon waits while broker_desired is false, preventing supervisor
restart storms after /ops stop. Native OS activation is an explicit user action.

## Operational boundary checks

Clone cancellation is owned by the broker rather than delegated to spawn's abort
error. On POSIX it terminates the owned process group, escalates to SIGKILL after
a grace period, and settles only on close. No clone directory is reserved for an
already-aborted request. Failed/partial directories remain available for review.

Question sends retain next_at across restart and respect Telegram retry-after.
Permanent send failures are terminal; unknown new sends remain uncertain. An
awaited topic lookup cannot reopen a cancelled or expired question. Cancellation
intent and acknowledgement are appended to Pi entries and replayed on reconnect.
Local status includes question records, making failed and uncertain waits visible.

Service stop persists broker_desired=false even when the broker cannot be reached.
Restart sets it true only after stopping the old instance. A failed launchd bootstrap
is tolerated by start only if the target job can actually be inspected.
