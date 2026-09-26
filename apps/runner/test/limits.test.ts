import { describe, expect, it } from 'vitest';
import { isUsageLimit, limitResetDelay } from '../src/limits.ts';

describe('usage limits', () => {
  it('recognises the CLIs limit messages', () => {
    expect(isUsageLimit('5-hour limit reached ∙ resets 3pm')).toBe(true);
    expect(isUsageLimit("You've hit your usage limit. Upgrade to Pro or try again in 2 hours 5 minutes.")).toBe(true);
    expect(isUsageLimit('Claude AI usage limit reached|1759003200')).toBe(true);
    expect(isUsageLimit('429 RESOURCE_EXHAUSTED: Quota exceeded for model')).toBe(true);
    expect(isUsageLimit('I vote for Sonnet because of the limit on messages')).toBe(false);
  });

  it('reads when the limit resets', () => {
    const now = new Date(2026, 8, 26, 13, 0, 0);
    expect(limitResetDelay('try again in 2 hours 5 minutes', now)).toBe(126 * 60_000);
    expect(limitResetDelay('limit reached ∙ resets 3pm', now)).toBe(121 * 60_000);
    expect(limitResetDelay(`usage limit reached|${Math.floor(now.getTime() / 1000) + 3600}`, now)).toBe(61 * 60_000);
    expect(limitResetDelay('usage limit', now)).toBe(15 * 60_000);
  });
});
