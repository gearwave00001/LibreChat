import { memo } from 'react';
import { useRecoilValue } from 'recoil';
import { Volume2, VolumeX } from 'lucide';
import { MorphIcon, TooltipAnchor } from '@librechat/client';
import { useTTSBrowser, useTTSExternal } from '~/hooks/Audio';
import { TTSEndpoints } from '~/common';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';

type ThinkingTTSProps = {
  /** The reasoning text to speak — only this part, never the response body. */
  content: string;
  messageId: string;
  isLast?: boolean;
  index?: number;
  className?: string;
  tabIndex?: number;
};

const ReadThoughtsButton = memo(
  ({
    isSpeaking,
    isLoading,
    onToggle,
    className,
    tabIndex,
  }: {
    isSpeaking: boolean;
    isLoading?: boolean;
    onToggle: () => void;
    className?: string;
    tabIndex?: number;
  }) => {
    const localize = useLocalize();
    const isBusy = isSpeaking || isLoading === true;
    const label = isBusy ? localize('com_ui_stop') : localize('com_ui_read_thoughts');

    return (
      <TooltipAnchor
        description={label}
        render={
          <button
            type="button"
            onClick={onToggle}
            tabIndex={tabIndex}
            aria-label={label}
            aria-pressed={isSpeaking}
            className={cn(
              'inline-flex shrink-0 items-center justify-center rounded-lg p-1.5 text-text-secondary',
              'transition-all duration-200 ease-out hover:bg-surface-hover hover:text-text-primary',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-heavy',
              className,
            )}
          >
            <MorphIcon icon={isBusy ? VolumeX : Volume2} size={18} />
          </button>
        }
      />
    );
  },
);

ReadThoughtsButton.displayName = 'ReadThoughtsButton';

const BrowserThinkingTTS = memo((props: ThinkingTTSProps) => {
  const { toggleSpeech, isSpeaking } = useTTSBrowser(props);
  return (
    <ReadThoughtsButton
      isSpeaking={isSpeaking}
      onToggle={toggleSpeech}
      className={props.className}
      tabIndex={props.tabIndex}
    />
  );
});

BrowserThinkingTTS.displayName = 'BrowserThinkingTTS';

const ExternalThinkingTTS = memo((props: ThinkingTTSProps) => {
  const { toggleSpeech, isSpeaking, isLoading } = useTTSExternal(props);
  return (
    <ReadThoughtsButton
      isSpeaking={isSpeaking}
      isLoading={isLoading}
      onToggle={toggleSpeech}
      className={props.className}
      tabIndex={props.tabIndex}
    />
  );
});

ExternalThinkingTTS.displayName = 'ExternalThinkingTTS';

/**
 * Read-aloud for a single reasoning disclosure. Speaks only the thought — the
 * main read-aloud button on the message row is what covers the response body.
 * Renders nothing when TTS is off or speech settings have not initialized yet,
 * matching the message-level speaker button.
 */
const ThinkingTTS = memo(({ content, ...rest }: ThinkingTTSProps) => {
  const textToSpeech = useRecoilValue(store.textToSpeech);
  const speechSettingsInitialized = useRecoilValue(store.speechSettingsInitialized);
  const engineTTS = useRecoilValue<string>(store.engineTTS);

  if (!content || !textToSpeech || !speechSettingsInitialized) {
    return null;
  }

  return engineTTS === TTSEndpoints.external ? (
    <ExternalThinkingTTS content={content} {...rest} />
  ) : (
    <BrowserThinkingTTS content={content} {...rest} />
  );
});

ThinkingTTS.displayName = 'ThinkingTTS';

export default ThinkingTTS;
