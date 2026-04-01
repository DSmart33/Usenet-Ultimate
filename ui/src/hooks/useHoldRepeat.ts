import { useRef, useCallback, useEffect } from 'react';

/** Hold-to-repeat hook: fires action immediately on pointer down, then repeats
 *  with accelerating frequency while held. Used for stepper +/− buttons. */
export function useHoldRepeat(action: () => void, initialDelay = 500, minDelay = 200) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const delay = useRef(initialDelay);

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    delay.current = initialDelay;
  }, [initialDelay]);

  const start = useCallback(() => {
    action();
    const tick = () => {
      timer.current = setTimeout(() => {
        action();
        delay.current = Math.max(minDelay, delay.current * 0.95);
        tick();
      }, delay.current);
    };
    tick();
  }, [action, minDelay]);

  useEffect(() => stop, [stop]);

  return { onPointerDown: start, onPointerUp: stop, onPointerLeave: stop, onPointerCancel: stop };
}
