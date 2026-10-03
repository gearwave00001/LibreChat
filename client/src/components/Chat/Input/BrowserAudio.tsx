import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { useSetRecoilState } from 'recoil';
import { useParams } from 'react-router-dom';
import { parseTextParts, stripThinkingTags } from 'librechat-data-provider';
import useTextToSpeechBrowser from '~/hooks/Input/useTextToSpeechBrowser';
import useAutoplayTrigger from '~/hooks/Audio/useAutoplayTrigger';
import { ttsIncludeThinkingAtom } from '~/store/ttsThinking';
import { logger } from '~/utils';
import store from '~/store';

/**
 * Autoplay driver for the Browser TTS engine. `StreamAudio` covers the external engine by
 * streaming server audio into the global `<audio>` element; the Web Speech API has no such
 * element, so the utterance is spoken directly off the shared autoplay gate.
 */
export default function BrowserAudio({ index = 0 }) {
  const { conversationId: paramId } = useParams();
  const setIsSpeaking = useSetRecoilState(store.globalAudioPlayingFamily(index));
  const setAudioRunId = useSetRecoilState(store.audioRunFamily(index));

  const { shouldPlay, activeRunId, latestMessage } = useAutoplayTrigger(index);
  const { generateSpeechLocal, cancelSpeechLocal } = useTextToSpeechBrowser({ setIsSpeaking });
  const ttsIncludeThinking = useAtomValue(ttsIncludeThinkingAtom);

  /**
   * Leaving a conversation (or unmounting) stops whatever is still being spoken. React runs
   * every cleanup before any effect body, so the utterance the effect below is about to start
   * survives the `/c/new` -> `/c/:id` navigation that lands in the same commit as finalization.
   */
  useEffect(() => {
    return () => cancelSpeechLocal();
    // We only want the effect to run when the paramId changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramId]);

  useEffect(() => {
    if (!shouldPlay || activeRunId == null || latestMessage == null) {
      return;
    }

    /** Autoplay mirrors the read-aloud extraction: thinking is spoken only when
     *  the user opted into hearing it. */
    const skipReasoning = !ttsIncludeThinking;
    const content = latestMessage.content;
    let text: string;
    if (Array.isArray(content) && content.length > 0) {
      text = parseTextParts(content, skipReasoning);
    } else if (skipReasoning) {
      text = stripThinkingTags(latestMessage.text);
    } else {
      text = latestMessage.text ?? '';
    }

    if (!text) {
      return;
    }

    logger.log('BrowserAudio.tsx - speaking message:', latestMessage.messageId);
    /** Only claim the run once an utterance was queued, so a not-yet-loaded voice list
     *  retries on the next render instead of silently swallowing the playback. */
    if (generateSpeechLocal(text)) {
      setAudioRunId(activeRunId);
    }
  }, [
    shouldPlay,
    activeRunId,
    latestMessage,
    setAudioRunId,
    generateSpeechLocal,
    ttsIncludeThinking,
  ]);

  return null;
}
