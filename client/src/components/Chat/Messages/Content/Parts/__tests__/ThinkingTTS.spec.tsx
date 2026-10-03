import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen } from '@testing-library/react';
import ThinkingTTS from '../ThinkingTTS';
import { TTSEndpoints } from '~/common';
import store from '~/store';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/hooks/Audio', () => ({
  useTTSExternal: () => ({
    toggleSpeech: jest.fn(),
    isSpeaking: false,
    isLoading: false,
    audioRef: { current: null },
  }),
  useTTSBrowser: () => ({
    toggleSpeech: jest.fn(),
    isSpeaking: false,
    audioRef: { current: null },
  }),
}));

const props = {
  content: 'Let me reason about this.',
  messageId: 'msg-1',
  isLast: true,
};

const renderThinkingTTS = (engine: string, { initialized = true, textToSpeech = true } = {}) =>
  render(
    <RecoilRoot
      initializeState={({ set }) => {
        set(store.engineTTS, engine);
        set(store.speechSettingsInitialized, initialized);
        set(store.textToSpeech, textToSpeech);
        set(store.playbackRate, 1);
      }}
    >
      <ThinkingTTS {...props} />
    </RecoilRoot>,
  );

describe('ThinkingTTS external player', () => {
  it('renders an auto-playing audio element with a message-scoped id', () => {
    renderThinkingTTS(TTSEndpoints.external);
    const audio = document.getElementById('audio-msg-1-thought');
    expect(audio).toBeInstanceOf(HTMLAudioElement);
    expect(audio).toHaveAttribute('autoplay');
  });

  it('exposes a separate id from the message-level audio element', () => {
    renderThinkingTTS(TTSEndpoints.external);
    expect(document.getElementById('audio-msg-1-thought')).not.toBeNull();
    // The message-level element StreamAudio/ExternalTTS manages is distinct.
    expect(document.getElementById('audio-msg-1')).toBeNull();
  });

  it('renders the read-thoughts button', () => {
    renderThinkingTTS(TTSEndpoints.external);
    expect(screen.getByRole('button', { name: 'com_ui_read_thoughts' })).toBeInTheDocument();
  });

  it('renders no audio element for the browser engine', () => {
    renderThinkingTTS(TTSEndpoints.browser);
    expect(document.getElementById('audio-msg-1-thought')).toBeNull();
    expect(screen.getByRole('button', { name: 'com_ui_read_thoughts' })).toBeInTheDocument();
  });

  it('renders nothing before speech settings initialize', () => {
    renderThinkingTTS(TTSEndpoints.external, { initialized: false });
    expect(document.getElementById('audio-msg-1-thought')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders nothing when text to speech is disabled', () => {
    renderThinkingTTS(TTSEndpoints.external, { textToSpeech: false });
    expect(screen.queryByRole('button')).toBeNull();
  });
});
