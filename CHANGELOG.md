# Changelog

## [0.1.2]

- Send only the final answer at task settlement; intermediate assistant/tool-use commentary stays in ephemeral drafts.
- Default Telegram delivery to silent; add `telegram.notifications` (`silent`, `important`, `all`). Status cards and continuation chunks always stay silent.
- Parse Markdown into native Telegram entities for final answers, drafts and interactive questions. Preserve code blocks, links and Unicode offsets across durable message chunks; render tables as readable rows.
- Disable final-answer link previews and remove the redundant topic welcome when `/new` already includes a prompt.

Run `bun install --frozen-lockfile --ignore-scripts` after updating to install the Markdown parser, then restart the broker/service and reload open Pi sessions. No Telegram setup rerun is needed.

## [0.1.1]

- Background Pi Agent sessions now inherit Pi tools, model and settings by default. Removed the plugin's default inspection-only tool allowlist.
- Load Pi's codemode, tool-search and MCP extension factories in SDK workers.
- Removed default 12-turn, five-minute and output-based execution aborts. Explicit user task limits remain supported; result storage excerpts do not stop execution.
- Automatically remove the previous injected defaults from legacy scheduled task records, preserving other custom values and paused/interrupted state.
- Verified real SDK bash execution, normal edit/write availability, and successful execution beyond 12 turns with offline model responses.

Restart the broker/service and reload open Pi sessions after updating. No Telegram setup rerun is needed.
