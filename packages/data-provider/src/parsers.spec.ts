import type { TMessageContentParts } from './types/content';
import { parseTextParts, stripThinkingTags } from './parsers';
import { ContentTypes } from './types/runs';

const thinkPart = (think: string): TMessageContentParts => ({ type: ContentTypes.THINK, think });
const textPart = (text: string): TMessageContentParts => ({ type: ContentTypes.TEXT, text });

describe('stripThinkingTags', () => {
  it('removes legacy :::thinking blocks and keeps the surrounding text', () => {
    expect(stripThinkingTags(':::thinking\npondering\n:::\nAnswer')).toBe('Answer');
  });

  it('removes <think> wrappers and keeps the surrounding text', () => {
    expect(stripThinkingTags('<think>pondering</think>Answer')).toBe('Answer');
  });

  it('removes both marker styles at once and collapses the gap they leave', () => {
    expect(stripThinkingTags(':::thinking\na\n::: middle <think>b</think> end')).toBe('middle end');
  });

  it('leaves plain text untouched', () => {
    expect(stripThinkingTags('Just a response.')).toBe('Just a response.');
  });

  it('returns an empty string for empty input', () => {
    expect(stripThinkingTags('')).toBe('');
    expect(stripThinkingTags(null)).toBe('');
    expect(stripThinkingTags(undefined)).toBe('');
  });
});

describe('parseTextParts', () => {
  it('includes the thinking part by default, speaking the thought and not its wrapper tags', () => {
    expect(parseTextParts([thinkPart('<think>pondering</think>'), textPart('Answer')])).toBe(
      'pondering Answer',
    );
  });

  it('skips the thinking part when skipReasoning is set', () => {
    expect(parseTextParts([thinkPart('<think>pondering</think>'), textPart('Answer')], true)).toBe(
      'Answer',
    );
  });

  it('skips thinking when the thinking part carries no wrapper tags either', () => {
    expect(parseTextParts([thinkPart('pondering'), textPart('Answer')], true)).toBe('Answer');
  });

  it('excludes mid-run user steer text by default', () => {
    const steerPart = { type: ContentTypes.STEER, steer: 'continue' } as TMessageContentParts;
    expect(parseTextParts([steerPart, textPart('Answer')])).toBe('Answer');
  });

  it('joins consecutive parts with a single space', () => {
    expect(parseTextParts([textPart('One'), textPart('Two')])).toBe('One Two');
  });
});
