/**
 * Viewport / input-mode hooks. Inside the MyGeotab mobile app (iPad) the
 * add-in renders in a 768–1024 px webview with touch, so editors go
 * full-screen, tables become cards and tap targets grow.
 */

import { useEffect, useRef, useState } from "react";

/** iPads report 810–1024 CSS px in portrait and up to 1366 in landscape — touch + ≤1400 counts as tablet too. */
export const TABLET_QUERY = "(max-width: 1024px), (pointer: coarse) and (max-width: 1400px)";
export const PHONE_QUERY = "(max-width: 700px)";
export const TOUCH_QUERY = "(pointer: coarse)";

export function useMedia(query: string): boolean {
  const get = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState<boolean>(get);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    if (typeof mql.addEventListener === "function") mql.addEventListener("change", onChange);
    else mql.addListener(onChange);
    return () => {
      if (typeof mql.removeEventListener === "function") mql.removeEventListener("change", onChange);
      else mql.removeListener(onChange);
    };
  }, [query]);
  return matches;
}

export interface Viewport {
  /** ≤ 1024 px, or a touch screen ≤ 1400 px (any iPad): full-screen editors, card lists. */
  tablet: boolean;
  /** ≤ 700 px — iPad split view / phones: single-column everything. */
  phone: boolean;
  touch: boolean;
}

export function useViewport(): Viewport {
  const tablet = useMedia(TABLET_QUERY);
  const phone = useMedia(PHONE_QUERY);
  const touch = useMedia(TOUCH_QUERY);
  return { tablet, phone, touch };
}

/** Width for a Zenith SidePanel: full-screen on tablets, otherwise the given px. */
export function panelWidth(vp: Viewport, desktop: number): number | string {
  return vp.tablet ? "100%" : desktop;
}

/**
 * Clamp an element's width to what is actually visible to its right.
 *
 * MyGeotab injects add-ins into its own page (no iframe). On the iPad app the
 * add-in container is laid out wider than the visible area (the nav rail
 * pushes it right without shrinking it), so right-aligned controls end up
 * off-screen. Measuring our own left edge against the window and capping
 * max-width makes the layout wrap inside the visible width wherever we are
 * hosted; it is a no-op when the container is already sized correctly.
 */
export function useFitToViewport<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window === "undefined") return;
    let frame = 0;
    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const left = Math.max(0, el.getBoundingClientRect().left);
        const visible = Math.floor((window.visualViewport?.width ?? window.innerWidth) - left);
        if (visible > 320) el.style.maxWidth = `${visible}px`;
      });
    };
    fit();
    window.addEventListener("resize", fit);
    window.addEventListener("orientationchange", fit);
    window.visualViewport?.addEventListener("resize", fit);
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
    if (ro && el.parentElement) ro.observe(el.parentElement);
    const t = window.setInterval(fit, 1500); // the nav rail expanding/collapsing fires no event we can hook
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", fit);
      window.removeEventListener("orientationchange", fit);
      window.visualViewport?.removeEventListener("resize", fit);
      ro?.disconnect();
      window.clearInterval(t);
    };
  }, []);
  return ref;
}
