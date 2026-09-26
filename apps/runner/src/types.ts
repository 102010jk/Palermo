import type { Api } from './api.ts';

export type AgentProvider = 'claude' | 'codex' | 'gemini' | 'agy' | 'bot';

export interface AgentSpec {
  /** Display name in the game (visible to others unless the game is anonymous). */
  name: string;
  provider: AgentProvider;
  /** Model passed to the CLI, e.g. "opus", "sonnet", "haiku", "gpt-5.6-sol", "gemini-3.8-flash". */
  model?: string;
  /** Override the CLI executable (default: claude / codex / gemini / agy). */
  command?: string;
  /** Extra CLI arguments appended as-is. */
  extraArgs?: string[];
  /** How Claude Code reaches the MCP server: local stdio bridge (default) or direct HTTP. */
  mcpTransport?: 'bridge' | 'http';
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
  /** Aborted when the agent must stop (removed from the AI waiting list, or the game started without it). */
  signal?: AbortSignal;
  /** Report the exact model the CLI resolved (e.g. "sonnet" -> "claude-sonnet-5") so stats are precise. */
  reportModel: (model: string) => void;
}

export interface Launch {
  attempt: number;
  prompt: string;
  /** Session id to resume (adapter-specific), if a previous attempt produced one. */
  resumeId?: string;
}

export interface RunResult {
  exitCode: number | null;
  /** Unrecoverable problem (not logged in, MCP unreachable): relaunching would not help. */
  fatal?: string;
  sessionId?: string;
  usage?: Usage;
  /** The provider's safety filter refused the conversation: resuming it would fail again, start a new one. */
  blocked?: string;
}

export interface Adapter {
  run(ctx: AgentContext, launch: Launch): Promise<RunResult>;
}

export const PROVIDER_NAME: Record<AgentProvider, string> = {
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'google',
  agy: 'google',
  bot: 'script',
};
