// Reveal [data-reveal] elements once they scroll into view.
//
// The <head> script adds `.js-reveal` only when the browser is allowed to
// animate, so with reduced motion — or with JS off entirely — nothing is ever
// left hidden. Everything here is transform + opacity, so it stays on the
// compositor.

export function setupReveal(): void {
  const targets = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'));
  if (targets.length === 0) return;

  const showAll = (): void => {
    for (const node of targets) node.classList.add('is-in');
  };

  if (
    !document.documentElement.classList.contains('js-reveal') ||
    typeof IntersectionObserver === 'undefined'
  ) {
    showAll();
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-in');
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -6% 0px', threshold: 0.06 },
  );

  for (const node of targets) observer.observe(node);
}
