<div align="center">
  <img src="docs/banner.png" alt="Pol" width="100%" />
</div>

# Pol

Send a file straight from one browser to another. Pick a file, get four words, hand them to the other side, and the transfer starts. Bytes travel over a WebRTC data channel: nothing is uploaded, no account is needed, and the server never holds the file.

**Live demo:** https://qqsp.ir/ — the page and the signaling server are the same origin, so there is nothing to configure.

> **Same network: direct and unlimited. Different networks: relayed, up to 200 MB.** When both devices share a network the transfer is direct with no size cap. Across networks the traffic goes through a TURN relay, and relay transfers are capped at 200 MB for now.

## What it does

- **Four-word code** — four Persian words from a 64-word list, easy to read over the phone and type on a mobile keyboard.
- **Direct transfer** — file bytes only use the data channel. The signal server introduces the two browsers and relays SDP/ICE; it never sees the file.
- **Integrity check** — both sides hash while the bytes move, and the digest rides along with the last control message. There is no separate pass over the file, so a large file starts sending right away and never needs its size in RAM twice.
- **Persian and RTL** — right-to-left interface, light and dark themes, Vazirmatn bundled locally. No external CDN.

## Run it

Requires Node 20 or newer.

```bash
npm install
npm run dev:signal   # terminal 1: signaling server on 8787
npm run dev          # terminal 2: client on 5173
```

Open two tabs, drop a file in one, type the code in the other.

For a deployment build, point it at your signaling server:

```bash
VITE_SIGNAL_URL=wss://example.com/signal npm run build
```

The client asks the signaling server for ICE servers at `GET /ice`. STUN is built in; TURN comes from [Metered](https://metered.ca) (free tier, 20 GB/month) when `METERED_APP` and `METERED_KEY` are set. Self-hosted coturn still works:

```bash
# server env — managed TURN (used first)
METERED_APP=your-app        # the part before .metered.live in the dashboard URL
METERED_KEY=...             # API key of the TURN credential

# or self-hosted TURN (fallback when METERED_* is absent)
TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:443
TURN_SECRET=...            # coturn REST secret: short-lived credentials per client
# or static credentials:
TURN_USERNAME=...
TURN_PASSWORD=...
```

The API key never reaches the browser: the server fetches short-lived credentials, caches them for 10 minutes, and hands those to clients.

```bash
npm test        # 50 tests: word codes, file sizes, SHA-256, ICE config, Metered
npm run build   # typecheck + production build
```

## How it works

```
index.html          one page, no UI framework
src/lib/            pure logic: word code, SHA-256, formatting
src/net/            signaling client and WebRTC transfer
server/signal.mjs   rooms and SDP/ICE relay (~150 lines)
```

The sender creates a data channel and offers; the receiver answers. Files are sliced into 64 KB chunks with backpressure at 4 MB buffered, then verified with SHA-256. A room code is only a room identifier — encryption comes from DTLS, and a key derived from the code (SPAKE2) is planned for v0.7.

Known limits:

- STUN is built in, so most home networks connect directly. Cross-network transfers go through a TURN relay and are capped at 200 MB for now; symmetric NAT and restrictive firewalls can still block even the relay path in rare cases.
- One file per session; folders and resume-after-disconnect are not built yet.
- The file is assembled in the tab's memory, so multi-gigabyte transfers are not practical yet.
- If the signal server is malicious it could theoretically sit in the middle. The code does not protect against that yet.

## فارسی

**پل** یک ایردراپ مرورگری است: فایل را روی یک دستگاه انتخاب می‌کنی، یک کد چهارکلمه‌ای می‌گیری، طرف مقابل کد را می‌زند و فایل مستقیم بین دو مرورگر جابه‌جا می‌شود. هیچ فایلی آپلود نمی‌شود و هیچ اکانتی لازم نیست.

دموی زنده: https://qqsp.ir/

**یک شبکه: مستقیم و بدون سقف. شبکه‌های جدا: با رله، تا ۲۰۰ مگابایت.** وقتی هر دو دستگاه روی یک شبکه‌اند، فایل مستقیم و بدون محدودیت حجم جابه‌جا می‌شود. بین دو شبکهٔ جدا ترافیک از رلهٔ TURN می‌گذرد و فعلاً تا ۲۰۰ مگابایت پذیرفته می‌شود.

```bash
npm install
npm run dev:signal   # ترمینال اول
npm run dev          # ترمینال دوم
```

- کد چهارکلمه‌ای فقط شناسهٔ اتاق است، نه رمز. رمزنگاری از خود WebRTC می‌آید.
- STUN داخل خود برنامه است، پس بیشتر شبکه‌های خانگی مستقیم وصل می‌شوند. انتقال بین دو شبکهٔ جدا از رلهٔ TURN می‌گذرد و فعلاً سقف ۲۰۰ مگابایت دارد.
- هر نشست یک فایل؛ پوشه و ادامهٔ انتقال بعد از قطعی هنوز نیست.
- فایل در حافظهٔ تب جمع می‌شود؛ برای فایل چند گیگابایتی مناسب نیست.
- سلامت فایل با SHA-256 بررسی می‌شود و در پایان، نتیجه روی هر دو طرف دیده می‌شود. هش هم‌زمان با ارسال حساب می‌شود، پس فایل بزرگ قبل از شروع یک دور اضافه خوانده نمی‌شود.

## License

MIT
