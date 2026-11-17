# pi-ops

A [Pi Agent](https://github.com/earendil-works/pi) extension for **persistent
operational memory and scheduled Agent work**. Give Pi a recurring task in natural
language; a scheduler launches independent Pi SDK sessions in the project directory,
with project context and memory, even after the interactive terminal closes.
Telegram connects to those Pi sessions through one elected local broker; HTTP checks
are also available as a lightweight task type.

## What it does today

A fact saved in one session is recalled in every later one — including a different
project, or a different machine sharing the same memory directory.

```
你说：nginx 又 502 了，上次怎么弄的
pi  ：（记忆里已经带着）nginx 502 是 upstream 超时，proxy_read_timeout 调到 60s
```

Recall includes current-project facts, project events and global facts. Other
projects stay out of the way. Project IDs distinguish unrelated same-named folders.

## Install

从旧 pi-telegram-operator 迁移或在实机首次安装，请先阅读 [迁移与实机安装指南](MIGRATION.md)。

Pi loads extensions from `~/.pi/agent/extensions/`. Link this directory there, or
copy it:

```bash
ln -s "$PWD" ~/.pi/agent/extensions/pi-ops
```

Requirements: Node >= 22.19 (for `node:sqlite`), pi >= 1.5.
Without SQLite the extension still works — recall degrades to a linear scan.

## Telegram connection

The transport follows the leader/client mechanism of
[JohnsonRan/pi-telegram-operator](https://github.com/JohnsonRan/pi-telegram-operator),
reviewed at commit `a9b444db4db0c95ab4d1eee8c86a122208b9d4b4`. This project implements
its own transport and combines the scheduler with the same elected broker.

1. Create a dedicated bot with BotFather and enable **Threaded Mode**.
2. Stop existing Pi Ops brokers with `/ops stop` (or `bun run ops stop`).
3. In a local terminal, run `node setup.cjs`. Enter the Bot Token in its hidden
   prompt; send the displayed one-time `/start <code>` to the bot in a private chat.
4. Setup verifies a topic can be created/deleted and optionally asks for a directory
   within which stopped sessions may be woken.
5. Load/reload Pi Ops in Pi. Each session gets a topic when it first sends output.

Setup stores the token separately in `telegram.secret` with mode 0600. It stores
only the bound chat/user IDs and operational options in `config.json`. Telegram is
disabled until setup succeeds. Do not send the token to an Agent or put it in a task
prompt. Bot identity and allowed user are checked on incoming messages.

Reply inside a session's topic to reach that exact Pi session. An idle session starts
a new turn; a busy session receives steering input. Send `/stop` in that topic to
abort it. Assistant text is streamed as a best-effort draft and sent as durable plain
text chunks when complete; thinking and raw tool outputs are excluded.

If a session is disconnected, incoming text remains queued. Reconnection reuses the
saved topic and delivers pending messages. With `telegram.wakeMode` enabled, a known
session with a saved transcript can resume automatically inside `wakeAllowedRoots`.
It opens that same Pi session/transcript through the SDK. These wake sessions use the
same Pi tool/model/settings configuration as a normal Pi session, without plugin-imposed
tool restrictions, turn caps or execution deadlines;
local side effects from an interrupted run require inspection before retrying.

The first Pi client tries the existing broker, then starts a detached daemon, then
falls back to becoming the leader itself. The port holder owns both TG polling and
scheduling; other clients reconnect after it disappears. The detached daemon waits
and attempts to acquire the port again after a handover. `/ops stop` records an
intentional stop so clients do not immediately restart it; `/ops start` re-enables it.
The optional service manager below provides automatic startup after login.

Topic mappings, polling offset, inbound messages and outbound chunks persist in
`schedule.db`. Input acknowledgement means Pi accepted the prompt, not that the
Agent completed it. A transport interruption while creating a topic or sending a
final message can leave an ambiguous result. Such entries remain `uncertain` for
inspection rather than being blindly sent twice.

```text
/ops tg status
/ops tg bind <session-id> <existing-topic-id>
/ops tg retry <outbox-key>
```

The first command lists this project's mappings and pending/failed work. Bind repairs
an uncertain topic mapping. Retry explicitly retries a failed/uncertain outbound
chunk; inspect the chat first because a previous send may already have arrived.
Uncertain inbound wake requests are retained for inspection and are not automatically
replayed; send a new message after checking any partial effects.

Scheduled incident/recovery notices go to the most recently registered session for
the matching project. Scheduled Agent sessions also publish their assistant output
through their own session topic.

This implements the reference's **core text connection**, not full feature parity.
Pinned session cards, Continue/Stop/Retry/Refresh buttons, photo/document exchange,
and remote `/new` are implemented. Single/multiple-choice questions, HTTPS repository cloning and macOS/Linux user
service management are also implemented. Rich widgets and Windows service installation
remain outside the current feature set.

## Telegram controls, files and remote sessions

Each session topic gets a pinned status card showing Ready, Working, Stopped or
Disconnected. Continue submits a continuation prompt; Stop aborts; Retry resubmits
the latest recorded user prompt; Refresh updates the card without invoking a model.
Callbacks must match the bound account, chat, topic and current card message.
Retry can repeat work, so inspect partial results before using it.

Send a photo or document inside a session topic to have it saved under the project's
`.pi-ops/inbox/<update-id>/` directory. The Agent receives its caption and local path
and can inspect it with `read`. Downloads are capped at 20 MiB. Filenames are
sanitized, and symlinked inbox directories are rejected.

Pi can call `telegram_send_file` with `path` and optional `caption` to queue a file
for that same topic. Uploads are capped at 50 MiB, and files resolving outside the
project are refused. Queue acceptance is separate from upload completion; failed or
uncertain uploads appear in `/ops tg status`. Scheduled Agent tasks needing this
capability must include `telegram_send_file` in their tools list.

In the bot's main chat (outside session topics), use:

```text
/new /absolute/project/path | Inspect the deployment and report findings
/new /absolute/project/path
/new | Inspect the default project
/sessions
/status
/help
```

Remote creation requires `telegram.wakeMode=true` and a canonical project directory
inside `wakeAllowedRoots`. Relative paths and an omitted folder use
`telegram.wakeDefaultCwd`, set to the allowed root by setup. The form without a prompt
creates a topic and reserved Pi session ID without calling a model; replying there
starts the session. `/sessions` lists known sessions.
New sessions inherit the same Pi configuration as offline wake, including normal
command/file tools and configured extensions/MCP.
`/clone <https-repository-url> [folder-name]` clones into `wakeDefaultCwd` and creates
a session topic. Only credential-free HTTPS URLs are accepted. Existing destinations
are refused; failed or interrupted clone directories are retained for inspection.
Cloning does not run a model until you send a prompt in the new topic. On supported
POSIX hosts, cancellation stops the Git process group, escalates if necessary, and
waits for process exit before allowing broker shutdown to finish.

Remote commands, attachments and callbacks are persisted before processing.
Interrupted actions and ambiguous status-card creation are retained for inspection
rather than automatically repeated. `/ops tg status` includes their state.
For an existing status card whose send response was lost, repair its mapping with:

```text
/ops tg card-bind <session-id> <message-id>
```

## Telegram questions

Pi can call `telegram_ask_user_question` with `question`, `options`, optional
`multiple`, and `timeoutSeconds` (default 300; at most 3600). A single selection
returns immediately. Multiple selections toggle checkmarks and return only after
Done; Cancel or timeout rejects the waiting tool. Answers go back to that tool,
not into a new Agent turn.

Questions and selections persist in SQLite. Rate-limited sends honor retry-after;
permanent send errors fail the waiting tool instead of retrying every poll.
Questions cancelled while disconnected are recorded in the Pi transcript and
replayed until the broker acknowledges cancellation. `/ops tg status` includes
question state and errors. A bridge reconnect resends the same
request key and resumes waiting; duplicate updates do not toggle twice. Account,
chat, topic and question message ID are checked on every selection. This preserves
connection recovery, not an in-memory tool call after its entire Pi process exits.
A send whose result is unknown is retained as uncertain for inspection.
Scheduled tasks must explicitly enable `telegram_ask_user_question` in their tools.

## Optional background service

The service script supports macOS launchd and Linux systemd **user** services.
Preview the exact definition before installing it:

```bash
node service.cjs install --dry-run
node service.cjs install
node service.cjs status
node service.cjs restart
node service.cjs stop
node service.cjs uninstall
```

Install writes a private service file and activates it. Model credentials remain in
Pi's agent directory; only PATH and operational proxy variables are captured from
the installing shell. Reinstall after moving this project or changing those values.
No service is installed merely by loading the Pi extension or running tests.

The managed daemon survives login sessions according to the service manager's user
service rules. On Linux, startup before login requires administrator-configured user
lingering; this script does not change that setting. Windows users can run the daemon
manually; Windows Task Scheduler integration is not implemented.

`/ops stop` leaves a managed daemon idle so the service manager does not fight an
intentional stop. `/ops start` re-enables leadership. `service.cjs stop` unloads/stops
the user service; `start` activates it again. All service operations run as the current
user, without sudo.

## Memory layout

Everything lives under `~/.pi/agent/pi-ops/` (or `$PI_CODING_AGENT_DIR/pi-ops/`).

```
pi-ops/
├── config.json                 settings (created on demand)
├── index.db                    SQLite search index (derived, safe to delete)
├── index.sig                   fingerprint used to detect hand edits
├── schedule.db                 tasks, runs, incidents and durable TG routing/queues
├── telegram.secret             Bot Token, mode 0600
├── scheduler.log               detached daemon output
├── tasks/sessions/<task-id>/    persistent Pi Agent session transcripts
└── memory/
    ├── global.md               facts valid everywhere
    ├── projects/<project-id>.md    facts scoped to one project folder
    └── events/<project-id>--2026-11.md       append-only operational log
```

Files are plain Markdown, one bullet per fact:

```markdown
- [2026-11-17] nginx 502 是 upstream 超时导致，proxy_read_timeout 调到 60s #nginx
```

You can edit, delete, grep and commit these by hand. The index notices the change
on the next session start and rebuilds itself.

## Usage

| Surface | What it does |
|---|---|
| `ops_schedule` tool | Save a recurring Pi Agent prompt and start the scheduler |
| `memory_save` tool | The model stores a durable fact when it learns one |
| `memory_search` tool | Look something up deliberately |
| `/memory` | Totals per scope, index status, current project scope |
| `/memory reindex` | Rebuild the index by hand |
| `/memory forget <id>` | Remove one entry (wrong or obsolete) |
| `/memory import-legacy` | Copy old folder-name memory into the current project |

Save and search results include the entry ID used by `/memory forget <id>`.
Multiline facts are flattened to one line; inline `#tags` are parsed as tags.
Explicit tags accept letters, numbers, underscores and hyphens.

Injection happens automatically on every user turn: the prompt is used as a query,
the top few facts become a `pi-ops-memory` prompt section. Short prompts such as
「好」are skipped, and the block always tells the model to prefer present
observations over remembered ones — memory is a hint, not an authority.

## Project identity

By default, project IDs use the canonical working-directory path and a readable
folder name. Symlinks resolve to the same project; unrelated folders with the same
name stay separate. Run Pi and the CLI from your project root.

To share a project identity across machines or directory moves, create
`.pi-ops.json` in that directory:

```json
{ "projectId": "payments" }
```

Explicit IDs accept 1–48 ASCII letters, digits, underscores or hyphens, starting
with a letter or digit. Changing an ID changes the visible scope; it does not move
existing records. For memory written by earlier versions, `/memory import-legacy`
explicitly copies the old folder-name facts. Original files are retained.

## Scheduled Pi Agent tasks

Inside Pi, ask for recurring work:

```text
每小时检查这个项目的部署状态，结合历史记忆汇报异常。
```

Pi can call `ops_schedule` with a name, prompt and `everySeconds`. This saves an
Agent task and starts the scheduler. It returns the task ID and explicitly reports
whether background startup succeeded. An alternative is to create it manually:

```text
/ops agent-add deployment-audit 3600 检查当前项目的部署状态，结合历史记忆汇报异常
/ops start
/ops list
/ops run <task-id>
/ops history <task-id>
```

Each run creates a genuine Pi SDK session with its own transcript. It uses the
project's cwd, context files and configured Pi credentials/model defaults, and
explicitly loads this extension so `memory_search` and `memory_save` are available.
It does not inject a prompt into your currently open conversation. Reusing live
interactive sessions is a later feature. Configure a working model/login in Pi
before executing Agent tasks; model calls use that provider's normal billing.

Tools and execution behavior are inherited from Pi settings by default. Pi Ops does
not impose a read-only allowlist, a twelve-turn cap, an output-driven abort, or a
five-minute execution deadline. The worker loads the standard codemode, tool-search
and MCP extension factories alongside the project's configured extensions and skills.
Pi's own model, tool selection and permission behavior still apply.

Only explicitly requested per-task `tools`, `maxTurns`, `timeoutSeconds` or output
limits override the inherited behavior. The stored result contains up to 100,000
characters of final text; this storage excerpt does not stop the Agent. Full output
remains in the Pi transcript. Telegram message chunking likewise does not limit
Agent execution.

On upgrade, pre-policyVersion tasks have the former injected defaults removed:
the exact old inspection-tool list, 12 turns, 32,000 output characters and 300,000ms
timeout. Other custom values are preserved. Previously interrupted scheduled tasks
remain paused until explicitly resumed; the upgrade does not replay partial work.
Restart the broker and reload open Pi sessions after updating.

Execution state is separate from the environment outcome. The Agent calls
`ops_report` with `healthy`, `degraded`, or `unknown`, plus an evidence-based summary.
Only completed runs reporting `degraded` count towards incident thresholds, and
only `healthy` closes an incident. A model/API error or missing report does not mean
that a service is unhealthy or recovered.

Timeouts, budget interruptions, worker failures and daemon restarts preserve an
uncertain result and block the Agent task. Inspect its history/transcript and any
partial effects, then explicitly use `/ops resume <task-id>` to allow future runs.
There is no automatic replay or rollback of Agent actions. Workers monitor their
parent IPC channel and abort when it disconnects; graceful shutdown waits for worker
termination before releasing scheduler ownership.

After updating an already-running older scheduler, use `/ops stop` then `/ops start`
to load Agent support. Tasks and HTTP checks both currently use fixed intervals.

## Scheduled HTTP checks

Run these from the project directory. Task names in `/ops` use a single word;
the CLI also accepts shell-quoted names containing spaces.

```bash
# Check every five minutes, with a ten-second timeout; expect HTTP 200.
bun run ops add gateway https://example.com/health 300 10 200
bun run ops start
bun run ops list

# Use the task ID returned by add/list.
bun run ops run <task-id>
bun run ops history <task-id>
bun run ops events
bun run ops pause <task-id>
bun run ops resume <task-id>
bun run ops status
bun run ops stop
```

The same commands are available inside Pi as `/ops ...`. Loading an unconfigured
extension does not start a broker. Configured Telegram sessions automatically connect
and bootstrap the shared broker. `start` launches an independent Node process;
`node daemon.cjs` runs it in the foreground. A machine reboot requires starting it
again unless the optional user service is installed.

The first automatic run happens one interval after creation. Three consecutive
failed checks or timeouts open one incident; continued failures do not repeat the
alert. The first successful check produces one recovery notification. View these
records using `ops events`; new transitions are also written to `scheduler.log`.
When Telegram is configured, incident/recovery records are also queued for delivery.
Agent tasks can perform model-based diagnosis.

Runs persist across restarts. Interrupted checks become `unknown`, and older missed
checks become `skipped` instead of creating a backlog. HTTP checks do not follow
redirects or read response bodies. Pause affects future automatic runs; an ongoing
check finishes, and manual runs remain available. Resume resets the failure streak.

Settings in `config.json` include `port` (default 43917), `schedule.enabled`, and
`schedule.misfireGraceMs` (default ten minutes). Stop the daemon before changing its
port. Up to four checks run concurrently, with one active run per task.
The HTTP task currently uses fixed intervals; cron schedules are later work.
Scheduling requires `node:sqlite`, even when memory is using its fallback scan.

**Keep `schedule.db`: it contains authoritative task and event history.** Unlike
`index.db`, it cannot be reconstructed from Markdown. Back up the state directory
while the daemon is stopped, or use SQLite's backup facilities.

## Why the index looks odd

SQLite's `unicode61` tokenizer treats a run of Han characters as one token, so
「服务器」never matches「服务器故障」. FTS5's `trigram` tokenizer fixes that but requires
three characters, which kills the most common ops words: 重启 / 超时 / 磁盘 / 内存.

So text is tokenized here: Han runs become overlapping bigrams, Latin and digits
stay whole. Two-character Chinese queries can therefore match inside longer runs;
a single character matches when it was indexed as a standalone Han segment.

## Development

```bash
bun install --frozen-lockfile
bun run typecheck  # TypeScript static checks
bun run check      # JavaScript syntax, TypeScript checks and all regression tests
```

Bun manages development dependencies; Node runs the tests to exercise the same
`node:sqlite` implementation used by pi. `npm run check` is also supported.
Extension tests resolve pi's own jiti loader through Node's module resolution,
so both regular installs and links to a host pi installation work.

## Roadmap

- [x] Persistent memory: storage, index, recall, injection
- [x] Scheduled HTTP checks: independent daemon, durable runs, incidents and recovery
- [x] Pi SDK Agent tasks: prompt execution, project context, memory, tool policy and run limits
- [ ] Cron schedules and live interactive-session routing
- [x] Telegram core: elected broker, topic per session, text routing/streaming, durable queues and known-session wake
- [x] Telegram session cards/buttons, photo/document exchange and remote session creation
- [x] Telegram single/multiple-choice questions and HTTPS repository cloning
- [x] macOS launchd / Linux systemd user service installer
- [ ] Windows service integration and rich widget UI
- [ ] Structured ops reports and topology view

See `ARCHITECTURE.md` for ownership, restart behavior and the remaining stages.
