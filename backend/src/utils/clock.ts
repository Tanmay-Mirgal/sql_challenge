/**
 * Single source of server time. Every authoritative timestamp (submission time,
 * round windows, penalties) must come from here, never from the client.
 * Tests can substitute a controllable clock.
 */
let source: () => Date = () => new Date();

export function now(): Date {
  return source();
}

export function setClock(fn: (() => Date) | undefined): void {
  source = fn ?? (() => new Date());
}
