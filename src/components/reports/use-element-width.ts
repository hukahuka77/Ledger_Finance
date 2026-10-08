"use client";

import { useCallback, useRef, useState } from "react";

/** A callback ref plus the element's current width, kept up to date with a ResizeObserver. */
export function useElementWidth<T extends HTMLElement>(initial = 900): [(el: T | null) => void, number] {
  const [width, setWidth] = useState(initial);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect();
    if (!el) return;
    setWidth(el.clientWidth || initial);
    observer.current = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.current.observe(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial is a fallback only
  }, []);
  return [ref, width];
}
