/**
 * Usage limits of the subscriptions behind the CLIs ("5-hour limit reached ∙ resets 3pm", Codex "You've hit your
 * usage limit … try again in 2 hours", Google RESOURCE_EXHAUSTED). When one hits, the game pauses and the agent
 * waits until the limit resets.
 */
const LIMIT = new RegExp(
  [
    'usage limit',
    'usage_limit',
    'limit reached',
    'hit your (?:usage |weekly |session )?limit',
    'weekly limit',
    'out of (?:extra )?usage',
    'quota exceeded',
    'exceeded your (?:current )?quota',
    'resource_exhausted',
    'rate_limit_exceeded',
  ].join('|'),
  'i',
);

export function isUsageLimit(text: string): boolean {
  return LIMIT.test(text);
}

const MIN = 60_000;

/** How long to wait before trying again, read from the message when it says; 15 minutes otherwise. */
export function limitResetDelay(text: string, now = new Date()): number {
  const clamp = (ms: number) => Math.min(8 * 60 * MIN, Math.max(2 * MIN, ms));
  // Claude Code: "Claude AI usage limit reached|1759003200" (unix seconds)
  const epoch = /\|(\d{10})\b/.exec(text);
  if (epoch) return clamp(Number(epoch[1]) * 1000 - now.getTime() + MIN);
  // "try again in 2 hours 13 minutes" / "in 45 minutes" / "in 1h 20m"
  const rel = /(?:try again|resets?|available again) in\s+(?:(\d+)\s*(?:hours?|hrs?|h)\b)?\s*(?:(\d+)\s*(?:minutes?|mins?|m)\b)?/i.exec(text);
  if (rel && (rel[1] || rel[2])) return clamp((Number(rel[1] ?? 0) * 60 + Number(rel[2] ?? 0) + 1) * MIN);
  // "resets 3pm", "resets at 11:30 am", "try again at 3:45 PM"
  const at = /(?:resets?|again)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text);
  if (at) {
    let h = Number(at[1]) % 12;
    if (at[3].toLowerCase() === 'pm') h += 12;
    const t = new Date(now);
    t.setHours(h, Number(at[2] ?? 0), 0, 0);
    if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
    return clamp(t.getTime() - now.getTime() + MIN);
  }
  return 15 * MIN;
}
