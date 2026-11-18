/**
 * Temporary on-device breadcrumbs. Keeps a tiny ring buffer of recent
 * significant events (WS frames, lane taps, sends, visibility changes) so a
 * crash alert can show what happened right before it. iOS Safari truncates
 * RangeError stacks to the repeating cycle, so the trigger context has to
 * come from here instead.
 *
 * TODO: remove once the root cause is confirmed.
 */
const CRUMB_LIMIT = 12;
const crumbs: string[] = [];

export function crumb(label: string): void {
  try {
    crumbs.push(`${Math.round(performance.now())}:${label}`);
    if (crumbs.length > CRUMB_LIMIT) crumbs.shift();
  } catch {
    // Diagnostics must never break the app.
  }
}

export function crumbSnapshot(): string {
  return crumbs.join(" > ");
}
