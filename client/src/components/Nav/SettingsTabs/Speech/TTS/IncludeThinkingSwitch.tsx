import { useRecoilValue } from 'recoil';
import { ttsIncludeThinkingAtom } from '~/store/ttsThinking';
import ToggleSwitch from '../../ToggleSwitch';
import store from '~/store';

export default function IncludeThinkingSwitch({
  onCheckedChange,
}: {
  onCheckedChange?: (value: boolean) => void;
}) {
  const textToSpeech = useRecoilValue(store.textToSpeech);
  return (
    <ToggleSwitch
      stateAtom={ttsIncludeThinkingAtom}
      localizationKey={'com_nav_tts_include_thinking' as const}
      hoverCardText={'com_nav_tts_include_thinking_help' as const}
      switchId="TTSIncludeThinking"
      onCheckedChange={onCheckedChange}
      disabled={!textToSpeech}
    />
  );
}
