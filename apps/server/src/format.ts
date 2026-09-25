import { ROLES, type Game, type GameEvent } from '@palermo/engine';

/** Compact text rendering of events and state for AI agents. Keep it short: every token is paid for every step. */

export function phaseLabel(g: Game): string {
  const s = g.state;
  if (s.phase === 'lobby') return 'Lobby';
  if (s.phase === 'ended') return 'Game over';
  return `${s.phase === 'night' ? 'Night' : 'Day'} ${s.round}`;
}

export function formatEvents(events: GameEvent[]): string {
  if (!events.length) return '(no new events)';
  return events
    .map((e) => {
      const where = e.phase === 'lobby' ? 'lobby' : e.phase === 'ended' ? 'end' : `${e.phase === 'night' ? 'N' : 'D'}${e.round}`;
      return `[${where}] ${e.text}`;
    })
    .join('\n');
}

export function formatStatus(g: Game, playerId: string): string {
  const v = g.view(playerId);
  const lines: string[] = [];
  lines.push(`== ${phaseLabel(g)} | game ${g.state.id} ==`);
  if (v.you) {
    const role = v.you.role ? ROLES[v.you.role].name : 'not assigned yet';
    lines.push(
      `You: ${v.you.name} | role: ${role}${v.you.team ? ` (${v.you.team})` : ''} | ${v.you.alive ? 'alive' : 'DEAD'}` +
        (v.you.teammates.length ? ` | fellow murderers: ${v.you.teammates.join(', ')}` : ''),
    );
  }
  const alive = v.players.filter((p) => p.alive).map((p) => p.name + identity(p));
  const dead = v.players
    .filter((p) => !p.alive)
    .map((p) => `${p.name}${p.role ? ` (${ROLES[p.role].name})` : ''}`);
  lines.push(`Alive (${alive.length}): ${alive.join(', ')}`);
  if (dead.length) lines.push(`Dead: ${dead.join(', ')}`);
  if (g.state.phase === 'day') {
    const votes = Object.entries(v.votes).map(([a, b]) => `${a}->${b}`);
    lines.push(`Votes ${v.votedCount}/${v.aliveCount}${votes.length ? `: ${votes.join(', ')}` : ''}`);
  }
  if (g.state.phaseEndsAt) {
    const sec = Math.max(0, Math.round((g.state.phaseEndsAt - Date.now()) / 1000));
    lines.push(`Time left in this phase: ${sec}s`);
  }
  const r = v.required;
  if (g.state.phase === 'ended') {
    lines.push(
      `GAME OVER. Winner: ${g.state.winner}. Now: 1) submit_report with a short summary and lessons, ` +
        `2) save_notes with your updated, condensed playbook, 3) stop playing.`,
    );
  } else if (r.kind !== 'none' || !r.done) {
    lines.push(`${r.done ? 'Done' : 'YOUR MOVE'}: ${r.hint}${r.options ? ` Options: ${r.options.join(', ')}` : ''}`);
  } else {
    lines.push(`Waiting: ${r.hint}`);
  }
  return lines.join('\n');
}

function identity(p: { model?: string; kind?: string; provider?: string }): string {
  if (p.kind === 'human') return ' [human]';
  if (p.model) return ` [${p.model}]`;
  return '';
}
