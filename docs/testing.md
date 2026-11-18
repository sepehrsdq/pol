# Testing

Four layers, each with a different job. None of them weakens an assertion to make a run pass; where a platform cannot run a test, the result says so.

## `npm test` — logic and server

121 tests in vitest: word codes, size formatting, SHA-256, CRC-32, ZIP, QR encode/decode (with a real decoder), the OPFS store, ICE/Metered credentials, room behaviour, transfer tuning, P-256, SPAKE2+ against the RFC 9383 vectors, and the session fingerprint.

## `npm run e2e` — the real flow in Chrome

Builds the client, starts the signaling server on 8797, launches the installed Chrome headless over CDP, and drives two tabs: three files, a text snippet, a folder as ZIP, a 96 MB transfer cut mid-flight and resumed, a 64 MB transfer cut, the receiver page reloaded, and the six security words compared on both sides. Exits non-zero on any mismatch. `--no-build` reuses `dist/`, `--size`/`--sizes` change the payloads, `E2E_CHROME` points at another Chrome.

## `npm run matrix` — other engines

The same core flow (code → connect → 1 MB file → hash → six words) through playwright. Start a signaling server on 8899 first: `PORT=8899 node server/signal.mjs` (macOS/Linux) or `$env:PORT=8899; node server/signal.mjs` (PowerShell). `POL_HOST` and `POL_SIGNAL_PORT` override the default `[::1]:8899`.

On this Windows machine the honest result is:

```
✓ chromium  size ok, fingerprint ok, console errors: 0
◐ firefox   API surface verified — transfer e2e not runnable on this machine
⊘ webkit    skipped: no WebRTC in this platform's build
```

- **Chromium** passes end to end.
- **Firefox**: playwright's build here gathers zero ICE candidates even for a bare `RTCPeerConnection` with STUN, so the transfer cannot run. The matrix still verifies that `RTCPeerConnection`, `RTCDataChannel` and `RTCIceCandidate` exist — Pol only uses standardized APIs. A real Firefox transfer needs a macOS/Linux runner or a manually installed Firefox.
- **WebKit**: playwright's Windows build ships without WebRTC (`RTCPeerConnection` is undefined). Safari must be tested on macOS/iOS.

The matrix runs on `[::1]`, not `localhost`: a local dev gateway on the development machine owns `127.0.0.1:8899`, and Firefox resolves `localhost` there. That is an environment collision, not a Pol bug. In production nothing else shares the port.

## `npm run a11y` — the page

A 23-point audit executed against the live page with the signaling server on 8899 (same `POL_HOST`/`POL_SIGNAL_PORT` overrides): landmarks, a single `h1`, `lang`/`dir`, accessible names on every visible interactive element, a global `:focus-visible` rule, `aria-live` for status and code, `role=alert`, a progressbar with `valuenow`, reduced-motion showing everything in its final state, labels on every input, and measured contrast for four real element pairs in both themes against the effective (non-transparent) background.

Current result: 23/23; minimum contrast 4.73 in light and 6.4 in dark.

## `npm run demo` — the README recording

Serves the app to two iframes on different origins (`127.0.0.1` and `localhost`), drives a real transfer, records the page, and encodes `docs/demo.gif`. Needs a normal ffmpeg with GIF support (`FFMPEG=/path/to/ffmpeg`, or `winget install Gyan.FFmpeg`, `brew install ffmpeg`, `apt install ffmpeg`); playwright's bundled ffmpeg is a cut-down build without `palettegen`.
