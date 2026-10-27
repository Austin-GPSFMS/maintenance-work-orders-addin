/**
 * Viewport / input-mode hooks. Inside the MyGeotab mobile app (iPad) the
 * add-in renders in a 768–1024 px webview with touch, so editors go
 * full-screen, tables become cards and tap targets grow.
 */

import { useEffect, useState } from "react";

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
