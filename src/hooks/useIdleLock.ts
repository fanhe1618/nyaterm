import { useCallback, useEffect, useRef } from "react";

/**
 * Monitors user inactivity and fires `onLock` after `minutes` of idle time.
 * When `minutes` is 0 (or falsy), the hook is completely inert.
 *
 * Tracked events: mousemove, mousedown, keydown, touchstart, scroll.
 */
export function useIdleLock(minutes: number, onLock: () => void) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onLockRef = useRef(onLock);
  onLockRef.current = onLock;

  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (minutes > 0) {
      timerRef.current = setTimeout(
        () => {
          onLockRef.current();
        },
        minutes * 60 * 1000,
      );
    }
  }, [minutes]);

  useEffect(() => {
    if (minutes <= 0) {
      // Disabled – clear any existing timer and bail
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    const EVENTS: (keyof WindowEventMap)[] = [
      "mousemove",
      "mousedown",
      "keydown",
      "touchstart",
      "scroll",
    ];

    // Start the initial timer
    resetTimer();

    // Reset on any user activity
    for (const evt of EVENTS) {
      window.addEventListener(evt, resetTimer, { passive: true });
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      for (const evt of EVENTS) {
        window.removeEventListener(evt, resetTimer);
      }
    };
  }, [minutes, resetTimer]);
}
