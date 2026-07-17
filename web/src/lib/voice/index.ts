// Local voice stack — a RealtimeSession over a fully in-browser transport (STT -> shared-model -> TTS).
//   startVoice() / stopVoice()   session lifecycle + mic capture + playback
//   voiceActive()                whether a session is live
// STT (Whisper) and TTS (Kokoro) run in-browser via ONNX; both are dep-gated (@huggingface/transformers
// + kokoro-js must be installed to run). The brain is the provider-aware SDK model the text agent uses.
export { startVoice, stopVoice, voiceActive } from "./session";
export { loadVoiceConfig, type VoiceConfig } from "./config";
