// Local voice stack — a RealtimeSession over a fully in-browser transport (STT→shared-model→TTS).
//   startVoice() / stopVoice()   session lifecycle + mic capture + playback
//   voiceActive()                whether a session is live
// STT (Whisper) and TTS (Kokoro) run in-browser via ONNX; both are dep-gated (add @huggingface/
// transformers + kokoro-js to run). The brain is the SAME provider-aware SDK model the text agent uses.
export { startVoice, stopVoice, voiceActive } from "./session";
export { loadVoiceConfig, type VoiceConfig } from "./config";
