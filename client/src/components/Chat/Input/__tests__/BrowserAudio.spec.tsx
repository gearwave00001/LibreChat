import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, waitFor } from '@testing-library/react';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Constants, ContentTypes, QueryKeys } from 'librechat-data-provider';
import type { TMessage, TConversation } from 'librechat-data-provider';
import { ttsIncludeThinkingAtom } from '~/store/ttsThinking';
import BrowserAudio from '../BrowserAudio';
import store from '~/store';

const conversationId = 'convo-1';
const voiceName = 'Test Voice';
const responseText = 'The capital of Germany is Berlin.';

const spoken: string[] = [];
let cancelCount = 0;

class FakeSpeechSynthesisUtterance {
  public voice: SpeechSynthesisVoice | null = null;
  public onend: (() => void) | null = null;
  public onerror: ((event: { error: string }) => void) | null = null;
  constructor(public text: string) {}
}

const fakeVoice = { name: voiceName, localService: true } as SpeechSynthesisVoice;

const speechSynthesis = {
  getVoices: () => [fakeVoice],
  addEventListener: () => undefined,
  speak: (utterance: FakeSpeechSynthesisUtterance) => {
    spoken.push(utterance.text);
  },
  cancel: () => {
    cancelCount += 1;
  },
};

const assistantMessage = {
  messageId: 'assistant-1',
  conversationId,
  parentMessageId: Constants.NO_PARENT,
  isCreatedByUser: false,
  text: responseText,
} as TMessage;

const thinkingMessage = {
  messageId: 'assistant-thinking',
  conversationId,
  parentMessageId: Constants.NO_PARENT,
  isCreatedByUser: false,
  text: responseText,
  content: [
    { type: ContentTypes.THINK, think: '<think>Let me reason about this.</think>' },
    { type: ContentTypes.TEXT, text: responseText },
  ],
} as TMessage;

const legacyThinkingMessage = {
  messageId: 'assistant-legacy',
  conversationId,
  parentMessageId: Constants.NO_PARENT,
  isCreatedByUser: false,
  text: ':::thinking\nLet me reason about this.\n:::\nThe answer is 42.',
} as TMessage;

const renderBrowserAudio = ({
  activeRunId = 'run-1',
  audioRunId = null,
  isSubmitting = false,
  messages = [assistantMessage],
  ttsIncludeThinking = false,
}: {
  activeRunId?: string | null;
  audioRunId?: string | null;
  isSubmitting?: boolean;
  messages?: TMessage[];
  ttsIncludeThinking?: boolean;
} = {}) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData([QueryKeys.messages, conversationId], messages);

  /** A fresh Jotai store per render: `atomWithStorage` only re-reads storage at
   *  mount, so the preference has to be written where the render can see it. */
  const jotaiStore = createStore();
  if (ttsIncludeThinking) {
    jotaiStore.set(ttsIncludeThinkingAtom, true);
  }

  return render(
    <QueryClientProvider client={queryClient}>
      <JotaiProvider store={jotaiStore}>
        <MemoryRouter initialEntries={[`/c/${conversationId}`]}>
          <RecoilRoot
            initializeState={({ set }) => {
              set(store.voice, voiceName);
              set(store.conversationByIndex(0), { conversationId } as TConversation);
              set(store.activeRunFamily(0), activeRunId);
              set(store.audioRunFamily(0), audioRunId);
              set(store.isSubmittingFamily(0), isSubmitting);
            }}
          >
            <Routes>
              <Route path="/c/:conversationId" element={<BrowserAudio index={0} />} />
            </Routes>
          </RecoilRoot>
        </MemoryRouter>
      </JotaiProvider>
    </QueryClientProvider>,
  );
};

/** Lets every effect settle so a missing utterance is a real absence, not a pending render */
const settle = () => waitFor(() => expect(cancelCount).toBeGreaterThanOrEqual(0));

describe('BrowserAudio autoplay', () => {
  beforeAll(() => {
    Object.defineProperty(window, 'speechSynthesis', {
      writable: true,
      configurable: true,
      value: speechSynthesis,
    });
    Object.defineProperty(global, 'SpeechSynthesisUtterance', {
      writable: true,
      configurable: true,
      value: FakeSpeechSynthesisUtterance,
    });
  });

  beforeEach(() => {
    spoken.length = 0;
    cancelCount = 0;
    localStorage.removeItem('ttsIncludeThinking');
  });

  it('speaks the finalized assistant message through speech synthesis', async () => {
    renderBrowserAudio();

    await waitFor(() => expect(spoken).toEqual([responseText]));
  });

  it('does not speak the thinking part of a structured message by default', async () => {
    renderBrowserAudio({ messages: [thinkingMessage] });

    await waitFor(() => expect(spoken).toEqual([responseText]));
  });

  it('speaks the thinking part when the user opted into hearing it', async () => {
    renderBrowserAudio({ messages: [thinkingMessage], ttsIncludeThinking: true });

    await waitFor(() =>
      expect(spoken).toEqual(['Let me reason about this. The capital of Germany is Berlin.']),
    );
  });

  it('strips embedded thinking markers from legacy text content by default', async () => {
    renderBrowserAudio({ messages: [legacyThinkingMessage] });

    await waitFor(() => expect(spoken).toEqual(['The answer is 42.']));
  });

  it('does not speak while the run is still submitting', async () => {
    renderBrowserAudio({ isSubmitting: true });
    await settle();

    expect(spoken).toEqual([]);
  });

  it('does not speak a run that was already played', async () => {
    renderBrowserAudio({ activeRunId: 'run-1', audioRunId: 'run-1' });
    await settle();

    expect(spoken).toEqual([]);
  });

  it('does not speak a message that is still streaming', async () => {
    const streamingMessage = { ...assistantMessage, messageId: 'user-1_' } as TMessage;
    renderBrowserAudio({ messages: [streamingMessage] });
    await settle();

    expect(spoken).toEqual([]);
  });

  it('does not speak the user message back to them', async () => {
    const userMessage = { ...assistantMessage, isCreatedByUser: true } as TMessage;
    renderBrowserAudio({ messages: [userMessage] });
    await settle();

    expect(spoken).toEqual([]);
  });

  it('cancels the utterance when the conversation is left', async () => {
    const { unmount } = renderBrowserAudio();

    await waitFor(() => expect(spoken).toEqual([responseText]));
    unmount();

    expect(cancelCount).toBeGreaterThan(0);
  });
});
