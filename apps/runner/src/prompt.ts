import { existsSync, readFileSync } from 'node:fs';
import { PROVIDER_NAME, type AgentContext } from './types.ts';

export function loadSkill(path: string): string {
  if (!existsSync(path)) throw new Error(`Skill file not found: ${path}`);
  // Strip YAML front matter; the body is used as (part of) the system prompt.
  return readFileSync(path, 'utf8').replace(/^---[\s\S]*?---\s*/, '');
}

export function startPrompt(ctx: AgentContext): string {
  const { spec } = ctx;
  return [
    `You are "${spec.name}", a player in the game Palermo. Your model: ${spec.model ?? 'unknown'}.`,
    `Game id: ${ctx.gameId}. Use the palermo MCP tools.`,
    `Start now: login(model="${spec.model ?? ''}", provider="${PROVIDER_NAME[spec.provider]}") -> join_game(game_id="${ctx.gameId}") -> set_ready -> get_notes -> then loop wait_for_events and act.`,
    'Play to WIN. Keep going until the status says GAME OVER, then submit_report, get_notes (latest version) and save_notes (merged).',
    'Never answer with plain text while the game is running: every turn must end with another tool call (usually wait_for_events).',
    `If join_game fails (the game already started or is full), stop right away: do not look for other games or keep retrying.`,
  ].join('\n');
}

export function continuePrompt(ctx: AgentContext): string {
  return [
    `Your session was interrupted, but game ${ctx.gameId} is still running and you are still seated.`,
    'Call login, then get_state (and get_history if you need context), then continue the wait_for_events loop.',
    'Do not stop until GAME OVER. Then submit_report and save_notes.',
  ].join('\n');
}

export function reportPrompt(ctx: AgentContext): string {
  return [
    `Game ${ctx.gameId} is over. Call login, then get_history to review the game,`,
    'then submit_report (summary + lessons), get_notes (latest playbook) and save_notes (merged, condensed). Then stop.',
  ].join('\n');
}
