import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { RecoilRoot } from 'recoil';
import { Provider as JotaiProvider } from 'jotai';
import IncludeThinkingSwitch from '../IncludeThinkingSwitch';
import { render, fireEvent } from 'test/layout-test-utils';
import store from '~/store';

describe('IncludeThinkingSwitch', () => {
  beforeEach(() => {
    localStorage.removeItem('ttsIncludeThinking');
  });

  it('renders the switch', () => {
    const { getByTestId } = render(
      <JotaiProvider>
        <RecoilRoot>
          <IncludeThinkingSwitch />
        </RecoilRoot>
      </JotaiProvider>,
    );

    expect(getByTestId('TTSIncludeThinking')).toBeInTheDocument();
  });

  it('reports the new value when toggled', () => {
    const onCheckedChange = jest.fn();
    const { getByTestId } = render(
      <JotaiProvider>
        <RecoilRoot>
          <IncludeThinkingSwitch onCheckedChange={onCheckedChange} />
        </RecoilRoot>
      </JotaiProvider>,
    );
    fireEvent.click(getByTestId('TTSIncludeThinking'));

    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('persists the choice in localStorage', () => {
    const { getByTestId } = render(
      <JotaiProvider>
        <RecoilRoot>
          <IncludeThinkingSwitch />
        </RecoilRoot>
      </JotaiProvider>,
    );
    fireEvent.click(getByTestId('TTSIncludeThinking'));

    expect(localStorage.getItem('ttsIncludeThinking')).toBe('true');
  });

  it('is disabled when text to speech is off', () => {
    const { getByTestId } = render(
      <JotaiProvider>
        <RecoilRoot
          initializeState={({ set }) => {
            set(store.textToSpeech, false);
          }}
        >
          <IncludeThinkingSwitch />
        </RecoilRoot>
      </JotaiProvider>,
    );

    expect(getByTestId('TTSIncludeThinking')).toBeDisabled();
  });
});
