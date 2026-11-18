# Changelog

Dates are the real commit dates. Versions before 0.6 were tagged retroactively; the history is the source of truth.

## 1.0.0 — 2026-11-19

- Final README: accurate commands, a recorded demo, and the testing story in `docs/testing.md`.
- `npm run demo`: records a real two-browser transfer into `docs/demo.gif`.
- Version 1.0.0 across `package.json`, the UI and the footer chip.

## 0.9.0 — 2026-11-18

- `npm run matrix`: the full flow on Chromium, Firefox and WebKit where the platform has WebRTC. Chromium passes end to end; Firefox and WebKit limitations are explicit, not hidden.
- `npm run a11y`: 23-point accessibility audit. 23/23; minimum contrast 4.73 light and 6.4 dark.

## 0.8.0 — 2026-11-17

- Terminal client: `npm run cli send <file>` / `receive <four words>` over `node-datachannel`.
- Same signaling, same transfer format, same SPAKE2 handshake and six-word fingerprint as the browser.
- Verified CLI↔CLI and CLI↔Chrome with matching hashes and fingerprints.

## 0.7.0 — 2026-11-16

- SPAKE2+ (RFC 9383) key derivation from the room code, with a hand-rolled P-256 and no runtime dependency.
- Six-word session fingerprint bound to both DTLS fingerprints; a tampering relay produces a visible mismatch.
- RFC 9383 test vectors pin the full chain byte for byte.

## 0.6.2 — 2026-11-16

- Interface rebuilt around paper, ink and one signal colour; light and dark are complete end to end.
- Live cable diagram, protocol terminal, reading hairline, reduced-motion variants.
- Missing assets answer 404 instead of the SPA shell.

## 0.6.0 — 2026-11-16

- Transfer tuning measured, not guessed: 64 KB chunks, 4 MB high-water mark, 1 MB threshold.
- `npm run bench` and `docs/benchmark.md`; the data channel is the bottleneck, not the code.

## 0.5.0 — 2026-11-15

- QR handoff with a built-in encoder; the room link lives in the URL hash.
- Installable PWA: manifest, icons, service worker, offline app shell.

## 0.4.0 — 2026-11-15

- Received bytes go to OPFS (memory fallback); resume after a dropped channel or a page reload, with the final hash still covering the whole file.

## 0.3.0 — 2026-11-14

- Text and clipboard sending; folders as a streaming ZIP.
- Multi-file sessions with a session total, ETA and completion state.

## 0.2.0 — 2026-11-13

- Cross-network transfers through a TURN relay, capped at 200 MB; direct transfers stay unlimited.
- Managed TURN credentials from Metered via `/ice`, cached for 10 minutes.

## 0.1.0 — 2026-11-12

- Direct browser-to-browser transfer over a WebRTC data channel.
- Four-word room code, SHA-256 integrity, a signaling server that relays only SDP/ICE.
- Deployed on Railway at `qqsp.ir`.
