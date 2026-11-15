# Transfer benchmark

- Date: 2026-11-15
- Chrome: Chrome/157.0.8103.79
- Machine: 8 logical cores, 8 GB RAM, win32
- File: 128 MB of random bytes, 3 run(s) per row
- Measured on the receiving tab: first received byte → SHA-256 match

```
config               chunk   high  low     runs  min MB/s  median  max   note
───────────────────  ──────  ────  ──────  ────  ────────  ──────  ────  ────
32 KB chunks         32 KB   4 MB  1 MB    3     8.9       8.9     9.5       
64 KB chunks         64 KB   4 MB  1 MB    3     8.5       9.8     10.4      
128 KB chunks        128 KB  4 MB  1 MB    3     8.2       9.1     9.7       
256 KB chunks        256 KB  4 MB  1 MB    3     8.6       9.1     9.5       
high water 1 MB      64 KB   1 MB  0.3 MB  3     8.7       9.1     9.1       
high water 2 MB      64 KB   2 MB  0.5 MB  3     7.2       8.4     12.6      
high water 4 MB      64 KB   4 MB  1 MB    3     7.2       9.4     12.4      
high water 8 MB      64 KB   8 MB  2 MB    3     9.1       9.3     11.9      
low water = 1 chunk  64 KB   4 MB  0.1 MB  3     9.1       9.2     9.4       
low water = 1 MB     64 KB   4 MB  1 MB    3     9.4       9.4     15.5      
low water = 3 MB     64 KB   4 MB  3 MB    3     8.1       9.4     9.6       
```

Sender side, where the time went (median per file):

```
config               chunks  hash     send   drain     read     recv hash
───────────────────  ──────  ───────  ─────  ────────  ───────  ─────────
32 KB chunks         4096    2347 ms  76 ms  10762 ms  975 ms   2267 ms  
64 KB chunks         2048    2150 ms  63 ms  9140 ms   1195 ms  2266 ms  
128 KB chunks        1024    2388 ms  60 ms  10389 ms  1049 ms  2289 ms  
256 KB chunks        512     2494 ms  55 ms  10654 ms  1001 ms  2219 ms  
high water 1 MB      2048    2376 ms  38 ms  11031 ms  968 ms   2286 ms  
high water 2 MB      2048    2469 ms  45 ms  11004 ms  1870 ms  2367 ms  
high water 4 MB      2048    2276 ms  66 ms  10226 ms  1071 ms  2166 ms  
high water 8 MB      2048    2206 ms  76 ms  8969 ms   1028 ms  2184 ms  
low water = 1 chunk  2048    2325 ms  78 ms  10427 ms  1001 ms  2242 ms  
low water = 1 MB     2048    2230 ms  64 ms  10293 ms  884 ms   2170 ms  
low water = 3 MB     2048    2313 ms  39 ms  10088 ms  1293 ms  2136 ms  
```

Round medians: 9.2 → 9.4 → 9.1 MB/s. Round-to-round movement is
the machine, not the configuration.

A single row's runs spread by up to 30% here, so medians that sit that
close are ties, not a ranking.

The same 64 KB configuration measured 16.1 MB/s in a short run on a cold
machine, against ~9 MB/s inside this matrix: this laptop slows down while
it stays loaded. Compare rows within the table, not this file to another
run.

Loopback numbers are an upper bound for this browser and disk path. A real
Wi-Fi or cross-network transfer is limited by the link, and by the TURN
relay when the peers cannot connect directly.
