import type { DistanceUnit } from "../types";

const METERS_PER_MILE = 1609.344;

export function metersToUnit(meters: number, units: DistanceUnit): number {
  return units === "mi" ? meters / METERS_PER_MILE : meters / 1000;
}

export function unitToMeters(value: number, units: DistanceUnit): number {
  return units === "mi" ? value * METERS_PER_MILE : value * 1000;
}

export function formatInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString();
}

export function formatDistance(meters: number | null | undefined, units: DistanceUnit): string {
  if (meters == null || !Number.isFinite(meters)) return "—";
  return `${formatInt(metersToUnit(meters, units))} ${units}`;
}

export function formatHours(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  return `${formatInt(seconds / 3600)} h`;
}

export function formatMoney(n: number | null | undefined, currency = "USD"): string {
  if (n == null || !Number.isFinite(n)) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

export function formatDate(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Today's date as an ISO date (local), e.g. 2026-10-27. */
export function todayIso(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** "2026-10-27" or a full ISO stamp → local midnight Date (null when unparseable). */
export function parseDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Any ISO value → "YYYY-MM-DD" in local time (what a native date input wants). */
export function toDateInputValue(v: string | null | undefined): string {
  const d = parseDate(v);
  return d ? todayIso(d) : "";
}

export function addMonths(d: Date, months: number): Date {
  const out = new Date(d.getTime());
  const day = out.getDate();
  out.setDate(1);
  out.setMonth(out.getMonth() + months);
  const last = new Date(out.getFullYear(), out.getMonth() + 1, 0).getDate();
  out.setDate(Math.min(day, last));
  return out;
}

export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

export function safeIso(d: Date | null | undefined): string | null {
  if (!d) return null;
  const t = d.getTime();
  if (!Number.isFinite(t) || Math.abs(t) > 8.64e15) return null;
  return d.toISOString();
}

export function uid(prefix = "l"): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function clampNumber(v: unknown, fallback: number | null = null): number | null {
  if (v === "" || v == null) return fallback;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : fallback;
}
