export interface AgentTask {
	id: string;
	name: string;
	cwd: string;
	project_id: string;
	prompt: string;
	tools: string[];
	maxTurns: number;
	maxOutputChars: number;
	resumeSessionFile?: string;
	newSessionId?: string;
	wake?: boolean;
}
export interface AgentProgress { sessionFile?: string; sessionId?: string; }
export interface OpsReport { outcome: 'healthy' | 'degraded' | 'unknown'; summary: string; }
