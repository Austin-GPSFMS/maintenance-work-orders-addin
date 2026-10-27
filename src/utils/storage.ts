import type { Settings } from "../types";

const KEY = "gpsfms.maintenanceWorkOrders.settings.v1";

export const DEFAULT_SETTINGS: Settings = {
  units: "mi",
  currency: "USD",
  dvirLookbackDays: 30,
  faultLookbackDays: 7,
  expiringDays: 60,
  expiringMeters: 8046.72, // 5,000 mi
  dueSoonFraction: 0.9,
  callsPerMinute: 600,
  laborRate: 95,
};

export function loadSettings(): Settings {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
