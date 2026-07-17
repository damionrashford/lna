// Browser voice config for the local voice stack (ASR/brain/TTS/VAD). Sample rates are fixed by the
// backends: whisper wants 16 kHz in, kokoro emits 24 kHz out.
export interface VoiceConfig {
  // No "brain" field by design: voice turns run through the same provider-aware SDK model the text
  // agent uses. These are only the voice-specific generation knobs handed to that model per turn.
  temperature: number;
  maxTokens: number;      // short replies keep TTS latency low

  ttsModelId: string;     // kokoro ONNX id
  ttsDtype: "fp32" | "fp16" | "q8" | "q4" | "q4f16";
  ttsVoice: string;
  ttsSpeed: number;

  asrModelId: string;     // whisper ONNX id (transformers.js)

  sttSampleRate: 16000;
  ttsSampleRate: 24000;

  // energy VAD thresholds (RMS over int16)
  vadStartRms: number;
  vadEndRms: number;
  vadSilenceMs: number;
  vadMinSpeechMs: number;
}

// Defaults: whisper-base.en, Kokoro-82M q8, af_heart.
export function loadVoiceConfig(over: Partial<VoiceConfig> = {}): VoiceConfig {
  return {
    temperature: 0.3,
    maxTokens: 200,
    ttsModelId: "onnx-community/Kokoro-82M-v1.0-ONNX",
    ttsDtype: "q8",
    ttsVoice: "af_heart",
    ttsSpeed: 1,
    asrModelId: "onnx-community/whisper-base.en",
    sttSampleRate: 16000,
    ttsSampleRate: 24000,
    vadStartRms: 700,
    vadEndRms: 400,
    vadSilenceMs: 700,
    vadMinSpeechMs: 250,
    ...over,
  };
}
