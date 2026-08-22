// Adapter placeholder. Copy the compiled ESPConnect LittleFS WASM wrapper and .wasm here.
// This project intentionally does NOT emulate LittleFS: the image must be produced by the real ESPConnect WASM implementation.
export async function createLittleFS(){throw new Error('LittleFS WASM adapter not installed. Copy ESPConnect src/wasm build output into wasm/littlefs.js and wasm/littlefs.wasm.');}
