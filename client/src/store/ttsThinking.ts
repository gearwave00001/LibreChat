import { createStorageAtom } from './jotai-utils';

const DEFAULT_TTS_INCLUDE_THINKING = false;

/**
 * Whether read-aloud (TTS) includes the model's reasoning/thinking text.
 *
 * Off by default: the transcript renders reasoning as a separate "Thoughts"
 * disclosure, so the main read-aloud button reads only the visible response.
 * Reasoning can still be heard on its own via the read button on the Thoughts
 * disclosure, or by opting this back on.
 */
export const ttsIncludeThinkingAtom = createStorageAtom<boolean>(
  'ttsIncludeThinking',
  DEFAULT_TTS_INCLUDE_THINKING,
);
