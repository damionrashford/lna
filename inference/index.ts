// @automo/inference — hardware-aware, provider-agnostic model access.
//   detectHardware() → recommendModel()   machine profile + model-size recommendation (browser APIs)
//   providerFor() / pickProvider()          unified interface over ollama / vllm / huggingface / browser
//   createBrowserEngine()                   in-browser WebGPU/WASM engine via transformers.js
export * from "./hardware";
export * from "./provider";
export * from "./transformers";
export * from "./embed";
