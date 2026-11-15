type TraceWindow = Window & { __polTrace?: string[] };

/**
 * Dev-only trace sink. Read it from the console with window.__polTrace.
 * A page opened with `?debug=1` records too, so the e2e suite can show what
 * the state machine did when something fails.
 */
export function trace(...parts: unknown[]): void {
  const debugPage =
    typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');
  if (!import.meta.env.DEV && !debugPage) return;
  const target = window as TraceWindow;
  target.__polTrace ??= [];
  target.__polTrace.push(`${(performance.now() / 1000).toFixed(2)}s ${parts.map((part) => String(part)).join(' ')}`);
}
