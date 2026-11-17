import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { Type } from "typebox";

/**
 * pi-ops: persistent operational memory for Pi.
 *
 * Memory is injected as a prompt section on every user turn and written back
 * either by the model (memory_save) or by the user (/memory). Retrieval is scoped
 * to the project of the current working directory, with global facts always in
 * play, so the same server knowledge surfaces from any session on any machine.
 */

const require = createRequire(import.meta.url);

const store: any = require("./src/memory/store.cjs");
const indexer: any = require("./src/memory/indexer.cjs");
const recall: any = require("./src/memory/recall.cjs");
const { readConfig }: any = require("./src/shared/config.cjs");
const { INDEX_PATH, OPS_DIR }: any = require("./src/shared/paths.cjs");
const { errorMessage, warn }: any = require("./src/shared/log.cjs");
const { projectFor }: any = require("./src/shared/project.cjs");
const { command: opsCommand }: { command: (args: string[], cwd: string) => Promise<string> } = require("./src/schedule/commands.cjs");
const scheduleStore: any = require("./src/schedule/store.cjs");
const scheduleRuntime: any = require("./src/schedule/runtime.cjs");
const { attachTelegram }: { attachTelegram: (pi: ExtensionAPI) => void } = require("./src/telegram/client.cjs");
const telegramFiles: { sendFile: (id: string, filePath: string, caption: string, requestId: string) => Promise<void> } = require("./src/telegram/client.cjs");
const telegramQuestions: { askQuestion:(id:string,input:{requestId:string,question:string,options:string[],multiple?:boolean,timeoutSeconds?:number},signal?:AbortSignal)=>Promise<string[]> } = require("./src/telegram/client.cjs");

const SECTION_KEY = "pi-ops-memory";
// Shorter prompts ("ok", "继续") match everything and are not worth a lookup.
const MIN_QUERY_CHARS = 4;

export default function piOps(pi: ExtensionAPI): void {
	const config = readConfig();
	let db: any = null;
	let projectScope = "global";
	let legacyScope = "";

	/**
	 * Open the index lazily and rebuild it when memory files changed on disk.
	 * The fingerprint catches hand edits, which no event can tell us about.
	 */
	function ensureIndex(refresh = false): any {
		if (db && !refresh) return db;
		db ??= indexer.openIndex(INDEX_PATH);
		if (!db) {
			warn("SQLite is unavailable; memory recall falls back to a linear scan");
			return null;
		}
		const signaturePath = path.join(OPS_DIR, "index.sig");
		const current = store.memorySignature();
		let previous = "";
		try {
			previous = fs.readFileSync(signaturePath, "utf8").trim();
		} catch {
			// First run: no signature yet.
		}
		if (previous !== current || indexer.countDocs(db) === 0) {
			try {
				store.rebuildIndex(db);
			} catch (error) {
				db.close();
				db = null;
				throw error;
			}
			try {
				fs.writeFileSync(signaturePath, current);
			} catch (error) {
				warn(`Cannot persist memory signature: ${errorMessage(error)}`);
			}
		}
		return db;
	}

	function scopeFor(name?: string): string {
		if (name === "global") return "global";
		if (name === "event") return `event:${projectScope.slice(8)}--${store.today().slice(0, 7)}`;
		return projectScope;
	}

	pi.on("session_start", async (_event, ctx) => {
		const project = projectFor(ctx.cwd);
		projectScope = project.scope;
		legacyScope = project.legacyScope;
		try {
			ensureIndex(true);
		} catch (error) {
			warn(`Cannot prepare the memory index: ${errorMessage(error)}`);
		}
	});

	pi.on("before_agent_start", async (event) => {
		delete event.systemPromptOptions.sections[SECTION_KEY];
		if (config.memory?.enabled === false) return;
		if (event.messageType !== "user") return;
		const prompt = String(event.prompt ?? "").trim();
		if (prompt.length < MIN_QUERY_CHARS) return;
		try {
			const hits = recall.recall(ensureIndex(), prompt, {
				scope: projectScope,
				limit: config.memory.recallLimit,
				minScore: config.memory.minScore,
			});
			const body = recall.buildInjectionBody(hits, {
				charBudget: config.memory.recallCharBudget,
			});
			// Mutating sections in place lets pi diff them and patch only what changed,
			// which keeps the prompt cache warm.
			if (body) event.systemPromptOptions.sections[SECTION_KEY] = body;
		} catch (error) {
			warn(`Memory recall failed: ${errorMessage(error)}`);
		}
	});

	pi.registerTool({
		name: "memory_save",
		label: "Save ops memory",
		description: [
			"Persist one durable operational fact to this machine's long-term memory, so later sessions and other projects can recall it.",
			"Save things that stay true and would be expensive to rediscover: server roles and addresses, ports, deploy paths, service dependencies, environment quirks, the real root cause of a past incident, or a workaround that is not obvious from the code.",
			"Do not save transient state (current load, today's logs), secrets, tokens or passwords, or anything already written down in the repository.",
			"Write one self-contained sentence in the same language the user speaks; include the host or service name so the fact makes sense on its own.",
		].join(" "),
		promptSnippet: "Store a durable operational fact (topology, root cause, workaround) in long-term memory.",
		promptGuidelines: [
			"Use memory_save when you learn something durable about the environment that the user would not want to explain twice.",
		],
		parameters: Type.Object(
			{
				body: Type.String({
					minLength: 1,
					description: "One self-contained sentence, e.g. 'server-01 的 nginx 403 由 SELinux 上下文引起，修复用 restorecon -Rv /var/www'",
				}),
				scope: Type.Optional(
					Type.Union([Type.Literal("global"), Type.Literal("project"), Type.Literal("event")], {
						description: "global = applies everywhere; project = this project only (default); event = dated operational log entry",
					}),
				),
				tags: Type.Optional(
					Type.Array(Type.String({ minLength: 1 }), {
						maxItems: 6,
						description: "Short tags such as nginx, selinux, postgres",
					}),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const target = scopeFor(params.scope);
			const { fact, created } = store.appendFact({
				scope: target,
				body: params.body,
				tags: params.tags ?? [],
			});
			store.indexFact(ensureIndex(), fact);
			return {
				content: [
					{
						type: "text",
						text: created
							? `Saved to ${target} memory [${fact.id}]: ${fact.body}`
							: `Already in ${target} memory [${fact.id}], nothing changed: ${fact.body}`,
					},
				],
				details: { id: fact.id, scope: target, created, file: fact.file ?? ctx.cwd },
			};
		},
	});

	pi.registerTool({
		name: "memory_search",
		label: "Search ops memory",
		description:
			"Search long-term operational memory for facts about this environment. Relevant facts are usually injected automatically; use this to look something up deliberately, for example when the user refers to an earlier incident.",
		promptSnippet: "Search long-term operational memory deliberately.",
		parameters: Type.Object(
			{
				query: Type.String({ minLength: 1, description: "Keywords, e.g. 'nginx 403' or '重启'" }),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum hits, default 8" })),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params) {
			const hits = recall.recall(ensureIndex(), params.query, {
				scope: projectScope,
				limit: params.limit ?? 8,
				minScore: 0.1,
			});
			const text = hits.length
				? hits.map((hit: any) => `- [${hit.date}] [${hit.id}] ${hit.body} (${hit.scope}, ${hit.score.toFixed(2)})`).join("\n")
				: "No matching memory.";
			return { content: [{ type: "text", text }], details: { count: hits.length } };
		},
	});

	pi.registerCommand("memory", {
		description: "Inspect ops memory: /memory [reindex|forget <id>|import-legacy]",
		handler: async (args, ctx) => {
			const [action, ...rest] = String(args ?? "").trim().split(/\s+/);
			const index = ensureIndex();

			if (action === "import-legacy") {
				let imported = 0;
				if (legacyScope && legacyScope !== projectScope) {
					for (const fact of store.readScope(legacyScope)) {
						if (store.appendFact({ ...fact, scope: projectScope }).created) imported++;
					}
					store.rebuildIndex(index);
				}
				ctx.ui.notify(`Imported ${imported} facts from ${legacyScope}; original files retained`, "info");
				return;
			}

			if (action === "reindex") {
				const result = store.rebuildIndex(index);
				ctx.ui.notify(`Memory reindexed: ${result.indexed} facts`, "info");
				return;
			}

			if (action === "forget") {
				const id = rest[0];
				if (!id) {
					ctx.ui.notify("Usage: /memory forget <id>", "warning");
					return;
				}
				const scopes = store.listScopes();
				const removed = scopes.filter((scope: string) => store.removeFact(scope, id)).length;
				if (removed) {
					store.rebuildIndex(index);
					ctx.ui.notify(`Forgot ${id}`, "info");
				} else {
					ctx.ui.notify(`No memory entry with id ${id}`, "warning");
				}
				return;
			}

			const scopes = store.listScopes();
			const facts = store.readAll();
			const counts = new Map<string, number>();
			for (const fact of facts) counts.set(fact.scope, (counts.get(fact.scope) ?? 0) + 1);
			const lines = [
				`Ops memory: ${facts.length} facts in ${scopes.length} scopes`,
				...[...counts.entries()].map(([scope, count]) => `  ${scope}: ${count}`),
				`Index: ${index ? `${indexer.countDocs(index)} documents` : "unavailable (linear scan)"}`,
				`Current project scope: ${projectScope}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerTool({
		name: "ops_schedule",
		label: "Schedule Pi Agent task",
		promptSnippet: "Schedule recurring project work in a Pi Agent session with operational memory.",
		promptGuidelines: ["Use ops_schedule when the user explicitly asks Pi to perform recurring work. Include a self-contained prompt and select only the tools needed by that task."],
		description: "Schedule a recurring prompt to run in an independent Pi Agent session in this project. Use when the user asks for recurring work. Each run loads this project's context and operational memory. By default only file inspection, memory and outcome-reporting tools are enabled; specify tools when the task needs other capabilities. Saves the task and starts the scheduler. Interrupted runs require inspection and an explicit resume.",
		parameters: Type.Object({
			name: Type.String({ minLength: 1, maxLength: 200 }),
			prompt: Type.String({ minLength: 1, maxLength: 20_000 }),
			everySeconds: Type.Integer({ minimum: 1, maximum: 31_536_000 }),
			timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
			tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 50 })),
			maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
		}, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			if (readConfig().schedule?.enabled === false) throw new Error("Scheduling is disabled in config.json");
			const index = scheduleStore.openSchedule();
			let task;
			try {
				task = scheduleStore.addTask(index, { kind: "agent", project: projectFor(ctx.cwd), name: params.name,
					prompt: params.prompt, intervalMs: params.everySeconds * 1000,
					timeoutMs: params.timeoutSeconds === undefined ? undefined : params.timeoutSeconds * 1000,
					tools: params.tools, maxTurns: params.maxTurns,
				});
			} finally { index.close(); }
			let schedulerStarted = false;
			let startupError = "";
			try { await scheduleRuntime.launchDaemon(); schedulerStarted = true; }
			catch (error) { startupError = errorMessage(error); }
			return { content: [{ type: "text", text: `Saved Pi Agent task ${task.id}: ${task.name}. Every ${params.everySeconds}s. ${schedulerStarted ? "Scheduler running." : `Scheduler did not start: ${startupError}. Use /ops start.`}` }],
				details: { taskId: task.id, projectId: task.project_id, schedulerStarted },
			};
		},
	});

	pi.registerTool({
		name: "telegram_send_file",
		label: "Send file to Telegram",
		description: "Queue a file from this project's working directory for delivery to this Pi session's Telegram topic. Use when the user asks for a report, image or other file in Telegram. Files outside the project are refused; maximum 50 MiB. Requires a configured Telegram connection. The result confirms durable queue acceptance, not completed upload.",
		parameters: Type.Object({ path: Type.String({minLength:1}), caption: Type.Optional(Type.String({maxLength:1024})) }, {additionalProperties:false}),
		async execute(id,params,_signal,_update,ctx) {
			await telegramFiles.sendFile(ctx.sessionManager.getSessionId(),params.path,params.caption || "",id);
			return {content:[{type:"text",text:"File queued for this session's Telegram topic."}],details:{queued:true}};
		},
	});
	pi.registerTool({
		name:"telegram_ask_user_question",label:"Ask via Telegram",
		description:"Ask the connected user a question in this Pi session's Telegram topic and wait for button selections. Enable multiple for a checklist with a Done button. Cancellation and timeout stop waiting without starting a separate Agent turn.",
		parameters:Type.Object({question:Type.String({minLength:1,maxLength:2000}),options:Type.Array(Type.String({minLength:1,maxLength:80}),{minItems:1,maxItems:12}),multiple:Type.Optional(Type.Boolean()),timeoutSeconds:Type.Optional(Type.Integer({minimum:1,maximum:3600}))},{additionalProperties:false}),
		async execute(id,params,signal,_update,ctx){const answer=await telegramQuestions.askQuestion(ctx.sessionManager.getSessionId(),{...params,requestId:`${ctx.sessionManager.getSessionId()}:question:${id}`},signal);return {content:[{type:"text",text:answer.join("\n")}],details:{answer}};},
	});

	pi.registerCommand("ops", {
		description: "Manage Pi Agent tasks and HTTP checks: /ops [help|start|stop|status|agent-add|add|list|run|pause|resume|history|events]",
		handler: async (args, ctx) => {
			try {
				const output = await opsCommand(args.trim().split(/\s+/).filter(Boolean), ctx.cwd);
				ctx.ui.notify(output, "info");
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	pi.on("session_shutdown", () => {
		try {
			db?.close();
		} catch {
			// Closing a closed handle is not worth reporting.
		}
		db = null;
	});
	attachTelegram(pi);
}
