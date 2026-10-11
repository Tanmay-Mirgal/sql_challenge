"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Counts down to `target` using the *server's* clock: `serverTime` (from the API) is
 * compared with the browser clock once to derive a skew, so a wrong device clock
 * doesn't change when rounds appear to open or close. Display only — the API
 * enforces the real deadlines.
 */
export function useCountdown(target: string | null | undefined, serverTime: string | undefined, onElapsed?: () => void) {
  const skew = useRef(0);
  const [remaining, setRemaining] = useState<number | null>(null);
  const elapsedFired = useRef(false);
  const callback = useRef(onElapsed);
  useEffect(() => {
    callback.current = onElapsed;
  });

  useEffect(() => {
    skew.current = serverTime ? new Date(serverTime).getTime() - Date.now() : 0;
  }, [serverTime]);

  useEffect(() => {
    elapsedFired.current = false;
    if (!target) {
      setRemaining(null);
      return;
    }
    const end = new Date(target).getTime();
    const tick = () => {
      const left = end - (Date.now() + skew.current);
      setRemaining(Math.max(0, left));
      if (left <= 0 && !elapsedFired.current) {
        elapsedFired.current = true;
        callback.current?.();
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [target]);

  return remaining;
}
