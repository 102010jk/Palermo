import type { Api } from './api.ts';

export type AgentProvider = 'claude' | 'codex' | 'gemini' | 'bot';

export interface AgentSpec {
  /** Display name in the game (visible to others unless the game is anonymous). */
  name: string;
  provider: AgentProvider;
  /** Model passed to the CLI, e.g. "opus", "sonnet", "haiku", "gpt-5.5", "gemini-3-flash". */
  model?: string;
  /** Override the CLI executable (default: claude / codex / gemini). */
  command?: string;
  /** Extra CLI arguments appended as-is. */
  extraArgs?: string[];
  /** Max relaunches if the CLI exits while the game is still running. */
  maxRestarts?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  durationMs: number | null;
}

export interface AgentContext {
  spec: AgentSpec;
  serverUrl: string;
  mcpUrl: string;
  token: string;
  gameId: string;
  workdir: string;
  freedomMode: boolean;
  skill: string;
  api: Api;
  log: (line: string) => void;
}

export interface Launch {
  attempt: number;
  prompt: string;
  /** Session id to resume (adapter-specific), if a previous attempt produced one. */
  resumeId?: string;
}

export interface RunResult {
  exitCode: number | null;
  sessionId?: string;
  usage?: Usage;
}

export interface Adapter {
  run(ctx: AgentContext, launch: Launch): Promise<RunResult>;
}

export const PROVIDER_NAME: Record<AgentProvider, string> = {
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'google',
  bot: 'script',
};
