import { describe, expect, it } from 'vitest';
import { parseAgyModels } from '../src/pool.ts';

describe('parseAgyModels', () => {
  it('reads the agy models table and skips headers and progress lines', () => {
    const out = [
      'Fetching available models...',
      'SLUG                      NAME',
      'gemini-3.8-flash-high     Gemini 3.8 Flash (High)',
      'claude-opus-4-6-thinking  Claude Opus 4.6 (Thinking)',
      'gpt-oss-120b-medium       GPT-OSS 120B (Medium)',
    ].join('\r\n');
    expect(parseAgyModels(out)).toEqual([
      { provider: 'agy', model: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
      { provider: 'agy', model: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
      { provider: 'agy', model: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
    ]);
  });
});
