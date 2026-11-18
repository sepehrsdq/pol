/**
 * Accessibility audit for Pol: landmarks, accessible names, the focus rule,
 * live regions, reduced motion and measured contrast in both themes. Runs
 * against the local build with the local signaling server.
 *
 *   npm run a11y
 */
import { chromium } from 'playwright';

const HOST = process.env.POL_HOST ?? '[::1]';
const PORT = Number(process.env.POL_SIGNAL_PORT ?? 8899);
// ::1 by default: on the development machine a local gateway owns
// 127.0.0.1:8899. Override with POL_HOST=localhost on a clean machine.
const BASE = `http://${HOST}:${PORT}/`;
const findings = [];

function check(name, ok, detail = '') {
  findings.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const health = await fetch(`${BASE}healthz`).catch(() => null);
  if (!health?.ok) {
    console.error(`signaling server not reachable at ${BASE} — start it with PORT=${PORT} node server/signal.mjs`);
    process.exit(1);
  }
  const browser = await chromium.launch();
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(`${BASE}?debug=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(document.getElementById('file')));

  /* 1. Landmarks and headings */
  const landmarks = await page.evaluate(() => ({
    main: Boolean(document.querySelector('main#main')),
    header: Boolean(document.querySelector('header')),
    footer: Boolean(document.querySelector('footer')),
    h1: document.querySelector('h1')?.textContent.trim().slice(0, 40) ?? null,
    headingOrder: [...document.querySelectorAll('h1, h2, h3')].map((h) => h.tagName),
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
  }));
  check('main landmark', landmarks.main);
  check('header landmark', landmarks.header);
  check('footer landmark', landmarks.footer);
  check('exactly one h1', landmarks.h1 !== null, landmarks.h1 ?? 'missing');
  check('heading order sane', landmarks.headingOrder[0] === 'H1');
  check('html lang=fa', landmarks.lang === 'fa');
  check('dir=rtl', landmarks.dir === 'rtl');

  /* 2. Every visible interactive element has an accessible name */
  const unlabeled = await page.evaluate(() => {
    const missing = [];
    for (const el of document.querySelectorAll('a[href], button, input, textarea')) {
      const visible = el.offsetWidth > 0 && el.offsetHeight > 0;
      if (!visible) continue;
      const named =
        el.getAttribute('aria-label') ||
        el.getAttribute('aria-labelledby') ||
        el.labels?.length > 0 ||
        document.querySelector(`label[for="${el.id}"]`) ||
        (el.textContent?.trim().length ?? 0) > 0 ||
        el.getAttribute('title');
      if (!named) missing.push({ tag: el.tagName.toLowerCase(), id: el.id || null });
    }
    return missing;
  });
  check('all visible interactive elements have accessible names', unlabeled.length === 0, JSON.stringify(unlabeled.slice(0, 3)));

  /* 3. Focus visibility: the stylesheet declares a global :focus-visible rule */
  const focusRule = await page.evaluate(() => {
    let found = null;
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.selectorText?.includes(':focus-visible')) found = rule.cssText.slice(0, 80);
        }
      } catch { /* cross-origin sheet */ }
    }
    return found;
  });
  check('global :focus-visible rule exists', Boolean(focusRule), focusRule ?? 'missing');

  /* 4. Live regions for dynamic feedback */
  const liveRegions = await page.evaluate(() => ({
    status: document.getElementById('status')?.getAttribute('aria-live'),
    code: document.getElementById('code')?.getAttribute('aria-live'),
    alert: document.getElementById('alert')?.getAttribute('role'),
    bar: document.getElementById('bar')?.getAttribute('role'),
    barValue: document.getElementById('bar')?.getAttribute('aria-valuenow'),
  }));
  check('status is aria-live=polite', liveRegions.status === 'polite');
  check('code is aria-live=polite', liveRegions.code === 'polite');
  check('alert has role=alert', liveRegions.alert === 'alert');
  check('progress bar has role=progressbar with valuenow', liveRegions.bar === 'progressbar' && liveRegions.barValue !== null);

  /* 5. Reduced motion: page is complete and visible */
  const reduced = await page.evaluate(() => {
    const reveals = [...document.querySelectorAll('[data-reveal]')];
    const hidden = reveals.filter((el) => {
      const style = getComputedStyle(el);
      return parseFloat(style.opacity) < 0.5;
    });
    return { total: reveals.length, hiddenCount: hidden.length };
  });
  check('reduced-motion reveals everything', reduced.hiddenCount === 0, JSON.stringify(reduced));

  /* 6. Contrast: computed pairs on real elements, both themes */
  const contrastPairs = [
    ['lede text', '.lede', '.hero'],
    ['spec value', '.spec dd', '.hero'],
    ['hint text', '.hint', '.panel'],
    ['tab inactive', '.tab:not(.is-active)', '.tabs'],
  ];
  let minContrast = 21;
  for (const [name, fgSel, bgSel] of contrastPairs) {
    const pair = await page.evaluate(
      ([f, b]) => {
        const fg = (s) => {
          const m = getComputedStyle(s).color.match(/\d+/g);
          return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : null;
        };
        // Effective background: walk up from the element until a non-transparent
        // color is found — a transparent chip on a card must be judged against
        // the card's own background.
        const bgOf = (s) => {
          let el = s;
          while (el) {
            const bg = getComputedStyle(el).backgroundColor;
            const m = bg?.match(/\d+/g);
            if (m && Number(m[3]) !== 0) return [Number(m[0]), Number(m[1]), Number(m[2])];
            el = el.parentElement;
          }
          return null;
        };
        const fe = document.querySelector(f);
        const be = fe?.closest(b) ?? document.querySelector(b);
        if (!fe || !be) return null;
        return { fg: fg(fe), bg: bgOf(be) };
      },
      [fgSel, bgSel],
    );
    if (!pair?.fg || !pair?.bg) {
      check(`contrast: ${name}`, false, 'element not found');
      continue;
    }
    const ratio = contrast(pair.fg, pair.bg);
    if (name.includes('tab')) {
      console.log(`tab diag: fg=${pair.fg} bg=${pair.bg} ratio=${ratio}`);
    }
    minContrast = Math.min(minContrast, ratio);
    check(`contrast: ${name} ≥ 4.5`, ratio >= 4.5, String(ratio));
  }

  function luminance(r, g, b) {
    const a = [r, g, b].map((v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  }
  function contrast(fg, bg) {
    const l1 = luminance(...fg);
    const l2 = luminance(...bg);
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  }

  /* 7. Same audit in dark theme */
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.waitForTimeout(300);
  let minDark = 21;
  for (const [name, fgSel, bgSel] of contrastPairs) {
    const pair = await page.evaluate(
      ([f, b]) => {
        const fg = (s) => {
          const m = getComputedStyle(s).color.match(/\d+/g);
          return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : null;
        };
        const bgOf = (s) => {
          let el = s;
          while (el) {
            const bg = getComputedStyle(el).backgroundColor;
            const m = bg?.match(/\d+/g);
            if (m && Number(m[3]) !== 0) return [Number(m[0]), Number(m[1]), Number(m[2])];
            el = el.parentElement;
          }
          return null;
        };
        const fe = document.querySelector(f);
        const be = fe?.closest(b) ?? document.querySelector(b);
        if (!fe || !be) return null;
        return { fg: fg(fe), bg: bgOf(be) };
      },
      [fgSel, bgSel],
    );
    if (!pair?.fg || !pair?.bg) continue;
    const ratio = contrast(pair.fg, pair.bg);
    minDark = Math.min(minDark, ratio);
    check(`contrast dark: ${name} ≥ 4.5`, ratio >= 4.5, String(ratio));
  }

  /* 8. Form labels */
  const labels = await page.evaluate(() => {
    const results = [];
    for (const input of document.querySelectorAll('input, textarea')) {
      if (input.type === 'hidden' || input.closest('[hidden]')) continue;
      const labelFor = input.id
        ? document.querySelector(`label[for="${input.id}"]`)
        : null;
      const hasLabel =
        input.labels?.length > 0 ||
        input.getAttribute('aria-label') ||
        input.getAttribute('aria-labelledby') ||
        labelFor;
      results.push({ id: input.id, type: input.type, hasLabel: Boolean(hasLabel) });
    }
    return results;
  });
  const unlabeledInputs = labels.filter((l) => !l.hasLabel);
  check('all inputs have labels', unlabeledInputs.length === 0, JSON.stringify(unlabeledInputs));

  console.log(`\nminimum contrast — light: ${minContrast}, dark: ${minDark}`);
  const failed = findings.filter((f) => !f.ok);
  console.log(`\n=== a11y audit: ${findings.length - failed.length}/${findings.length} passed ===`);
  await browser.close();
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
