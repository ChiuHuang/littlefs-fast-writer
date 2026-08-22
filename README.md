# ESP LittleFS Fast Writer

This is a focused Web Serial uploader: it reads the partition table at `0x8000`, finds a LittleFS partition, builds a **new** image in browser memory, then erases/writes that partition. It never downloads the existing filesystem.

## Why the WASM files are not bundled

The project is wired to an adapter at `wasm/littlefs.js`, but this ZIP does not redistribute ESPConnect's compiled WASM artifacts. Copy/build the corresponding LittleFS WASM wrapper from ESPConnect `src/wasm` into `wasm/` and expose `createLittleFS()` as documented in `wasm/littlefs.js`.

## Run

Serve the folder from localhost (Web Serial needs a secure context/localhost), for example:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000` in Chrome or Edge.

## Important

The exact LittleFS image configuration must match your firmware. Check the ESPConnect WASM wrapper/API and your ESP32 LittleFS build settings before flashing production data.
