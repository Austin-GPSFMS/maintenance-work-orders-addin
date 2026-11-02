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
  syncToGeotab: true,
  // 1 = open and 5 = completed are confirmed on gpsfms_pilot; the others are guesses until checked in Maintenance Center.
  statusCodeMap: { open: 1, in_progress: 1, on_hold: 1, completed: 5, cancelled: 1 },
  priorityCodeMap: { low: 100, medium: 100, high: 100, critical: 100 },
  severityCodeMap: { low: 0, medium: 100, high: 200, critical: 200 },
};

export function loadSettings(): Settings {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      statusCodeMap: { ...DEFAULT_SETTINGS.statusCodeMap, ...(parsed.statusCodeMap ?? {}) },
      priorityCodeMap: { ...DEFAULT_SETTINGS.priorityCodeMap, ...(parsed.priorityCodeMap ?? {}) },
      severityCodeMap: { ...DEFAULT_SETTINGS.severityCodeMap, ...(parsed.severityCodeMap ?? {}) },
    };
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
