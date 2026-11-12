type TraceWindow = Window & { __polTrace?: string[] };

/** Dev-only trace sink. Read it from the console with window.__polTrace. */
export function trace(...parts: unknown[]): void {
  if (!import.meta.env.DEV) return;
  const target = window as TraceWindow;
  target.__polTrace ??= [];
  target.__polTrace.push(parts.map((part) => String(part)).join(' '));
}
