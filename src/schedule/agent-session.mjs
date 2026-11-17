// @ts-check
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import projectModule from '../shared/project.cjs';
import paths from '../shared/paths.cjs';
import telegramClient from '../telegram/client.cjs';

/**
 * One genuine Pi SDK session per run. Dependency injection is only used by tests;
 * production always imports the installed Pi SDK.
 * @param {import('./agent-types.js').AgentTask} task
 * @param {{runId: string, signal?: AbortSignal, onProgress?: (value: import('./agent-types.js').AgentProgress) => void, sdk?: typeof import('@earendil-works/pi-coding-agent')}} options
 */
export async function executeSession(task, { runId, signal, onProgress = () => {}, sdk } ) {
	const pi = sdk ?? await import('@earendil-works/pi-coding-agent');
	if (signal?.aborted) throw new Error('Agent run cancelled before startup');
	const project = projectModule.projectFor(task.cwd);
	if (project.id !== task.project_id) throw new Error('Project identity changed; recreate the task in its current project');
	/** @type {import('./agent-types.js').OpsReport | undefined} */
	let report;
	/** @type {string | undefined} */
	let budgetError;
	let turns = 0;
	let outputChars = 0;
	const sessionManager = task.resumeSessionFile
		? pi.SessionManager.open(task.resumeSessionFile, undefined, task.cwd)
		: pi.SessionManager.create(task.cwd, path.join(paths.OPS_DIR, 'tasks', 'sessions', task.id), task.newSessionId ? { id: task.newSessionId } : undefined);
	const settingsManager = pi.SettingsManager.create(task.cwd, paths.AGENT_DIR);
	const loader = new pi.DefaultResourceLoader({
		settingsManager,
		extensionFactories: [pi.createCodemodeExtension(), pi.createToolSearchExtension(), pi.createMcpExtension()],
		cwd: task.cwd, agentDir: paths.AGENT_DIR,
		additionalExtensionPaths: [fileURLToPath(new URL('../../index.ts', import.meta.url))],
	});
	await loader.reload();
	if (signal?.aborted) throw new Error('Agent run cancelled during startup');
	const { session, extensionsResult } = await pi.createAgentSession({
		cwd: task.cwd, agentDir: paths.AGENT_DIR, resourceLoader: loader, sessionManager, settingsManager,
		...(task.tools === undefined ? {} : { tools: task.tools }),
		customTools: [{
			name: 'ops_report', label: 'Report scheduled task outcome',
			description: 'Record the observed environment outcome with evidence in the summary. healthy = verified healthy; degraded = verified problem; unknown = insufficient evidence. Execution errors are not proof of a service incident.',
			parameters: Type.Object({ outcome: Type.Union([Type.Literal('healthy'), Type.Literal('degraded'), Type.Literal('unknown')]), summary: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false }),
			async execute(_id, params) {
				report = /** @type {import('./agent-types.js').OpsReport} */ (params);
				return { content: [{ type: 'text', text: 'Outcome recorded.' }], details: params };
			},
		}],
	});
	const progress = { sessionFile: sessionManager.getSessionFile(), sessionId: sessionManager.getSessionId() };
	const cancel = () => { void session.abort(); };
	const unsubscribe = session.subscribe(event => {
		if (event.type === 'turn_start') { turns++; if(task.maxTurns !== undefined && turns > task.maxTurns) budgetError = 'Agent turn limit exceeded'; }
		if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
			outputChars += event.assistantMessageEvent.delta.length;
			if (task.maxOutputChars !== undefined && outputChars > task.maxOutputChars) budgetError = 'Agent output limit exceeded';
		}
		if (budgetError) cancel();
	});
	signal?.addEventListener('abort', cancel, { once: true });
	try {
		onProgress(progress);
		if (extensionsResult.errors.length) throw new Error(`Pi extension load failed: ${extensionsResult.errors.map(error => error.error).join('; ').slice(0, 2000)}`);
		await session.bindExtensions({ mode: 'print' });
		if (signal?.aborted) throw new Error('Agent run cancelled during startup');
		await session.prompt(task.wake ? task.prompt : `Scheduled Pi Ops task: ${task.name}\nTask ID: ${task.id}\nRun ID: ${runId}\nExecute the task below using this project and its operational memory. Before finishing, call ops_report with an evidence-based environment outcome.\n\n${task.prompt}`, { expandPromptTemplates: false, source: 'extension' });
		const last = [...session.messages].reverse().find(message => message.role === 'assistant');
		const output = (session.getLastAssistantText() || '').slice(0, task.maxOutputChars ?? 100000);
		if (signal?.aborted || budgetError || last?.stopReason === 'aborted') {
			return { ...progress, status: 'unknown', outcome: 'unknown', summary: budgetError || 'Agent run interrupted', output, turns };
		}
		if (last?.stopReason === 'error') return { ...progress, status: 'failure', outcome: 'unknown', summary: last.errorMessage || 'Pi model request failed', output, turns };
		return { ...progress, status: 'success', outcome: report?.outcome ?? 'unknown', summary: report?.summary ?? 'Pi Agent completed without a verified environment outcome', output, turns };
	} finally {
		await telegramClient.finishSession(sessionManager.getSessionId(), signal?.aborted ? 0 : 5000);
		signal?.removeEventListener('abort', cancel);
		unsubscribe();
		session.dispose();
		await session.modelRuntime.settleCredentialWrites();
	}
}
