# Changelog

## [0.1.1]

- Background Pi Agent sessions now inherit Pi tools, model and settings by default. Removed the plugin's default inspection-only tool allowlist.
- Load Pi's codemode, tool-search and MCP extension factories in SDK workers.
- Removed default 12-turn, five-minute and output-based execution aborts. Explicit user task limits remain supported; result storage excerpts do not stop execution.
- Automatically remove the previous injected defaults from legacy scheduled task records, preserving other custom values and paused/interrupted state.
- Verified real SDK bash execution, normal edit/write availability, and successful execution beyond 12 turns with offline model responses.

Restart the broker/service and reload open Pi sessions after updating. No Telegram setup rerun is needed.
