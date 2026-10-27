/**
 * Pure warranty + service-schedule maths (no API, no React) — exercised by
 * test/run.mjs.
 */

import type {
  CoverageEvaluation,
  DistanceUnit,
  ScheduleEvaluation,
  ServiceSchedule,
  Settings,
  VehicleSnapshot,
  WarrantyCoverage,
  WorkOrder,
} from "../types";
import { addMonths, daysBetween, formatDistance, formatHours, parseDate, safeIso } from "./format";

/** Coverage end date: explicit endDate, else startDate + months. */
export function coverageEndDate(c: WarrantyCoverage): Date | null {
  if (c.endDate) return parseDate(c.endDate);
  const start = parseDate(c.startDate);
  if (!start || c.months == null) return null;
  return addMonths(start, c.months);
}

export function evaluateCoverage(
  c: WarrantyCoverage,
  snap: VehicleSnapshot | undefined,
  settings: Pick<Settings, "expiringDays" | "expiringMeters" | "units">,
  now = new Date()
): CoverageEvaluation {
  const reasons: string[] = [];
  const units: DistanceUnit = settings.units;
  const start = parseDate(c.startDate);
  const end = coverageEndDate(c);
  let state: CoverageEvaluation["state"] = "active";
  let daysLeft: number | null = null;
  let metersLeft: number | null = null;
  let engineSecondsLeft: number | null = null;
  let known = false;

  if (start && start.getTime() > now.getTime()) {
    reasons.push(`Starts ${start.toLocaleDateString()}`);
    return { state: "not_started", reasons, endsOn: safeIso(end), daysLeft: daysBetween(now, start), metersLeft: null, engineSecondsLeft: null };
  }

  if (end) {
    known = true;
    daysLeft = daysBetween(now, end);
    if (daysLeft < 0) {
      state = "expired";
      reasons.push(`Ended ${end.toLocaleDateString()} (${Math.abs(daysLeft)} days ago)`);
    } else {
      reasons.push(`${daysLeft} days left (ends ${end.toLocaleDateString()})`);
      if (daysLeft <= settings.expiringDays && state === "active") state = "expiring";
    }
  }

  if (c.limitMeters != null) {
    const base = c.startMeters ?? 0;
    if (snap?.odometerMeters != null) {
      known = true;
      metersLeft = base + c.limitMeters - snap.odometerMeters;
      if (metersLeft < 0) {
        state = "expired";
        reasons.push(`Over by ${formatDistance(-metersLeft, units)} (limit ${formatDistance(base + c.limitMeters, units)})`);
      } else {
        reasons.push(`${formatDistance(metersLeft, units)} left of ${formatDistance(c.limitMeters, units)}`);
        if (metersLeft <= settings.expiringMeters && state === "active") state = "expiring";
      }
    } else {
      reasons.push("No odometer reading — distance limit not checked");
    }
  }

  if (c.limitEngineSeconds != null) {
    const base = c.startEngineSeconds ?? 0;
    if (snap?.engineSeconds != null) {
      known = true;
      engineSecondsLeft = base + c.limitEngineSeconds - snap.engineSeconds;
      if (engineSecondsLeft < 0) {
        state = "expired";
        reasons.push(`Over by ${formatHours(-engineSecondsLeft)} (limit ${formatHours(base + c.limitEngineSeconds)})`);
      } else {
        reasons.push(`${formatHours(engineSecondsLeft)} left of ${formatHours(c.limitEngineSeconds)}`);
        if (engineSecondsLeft <= 100 * 3600 && state === "active") state = "expiring";
      }
    } else {
      reasons.push("No engine-hours reading — hours limit not checked");
    }
  }

  if (!known) {
    if (!end && c.limitMeters == null && c.limitEngineSeconds == null) {
      reasons.push("No end date or limits — treated as open-ended");
      return { state: "active", reasons, endsOn: null, daysLeft: null, metersLeft: null, engineSecondsLeft: null };
    }
    return { state: "unknown", reasons, endsOn: safeIso(end), daysLeft, metersLeft, engineSecondsLeft };
  }
  return { state, reasons, endsOn: safeIso(end), daysLeft, metersLeft, engineSecondsLeft };
}

/** Coverages that would pay for work on this vehicle today (active or expiring). */
export function activeCoverages(
  deviceId: string,
  coverages: WarrantyCoverage[],
  snap: VehicleSnapshot | undefined,
  settings: Pick<Settings, "expiringDays" | "expiringMeters" | "units">,
  now = new Date()
): Array<{ coverage: WarrantyCoverage; evaluation: CoverageEvaluation }> {
  return coverages
    .filter((c) => c.deviceId === deviceId)
    .map((coverage) => ({ coverage, evaluation: evaluateCoverage(coverage, snap, settings, now) }))
    .filter((x) => x.evaluation.state === "active" || x.evaluation.state === "expiring");
}

export const COVERAGE_TYPE_LABEL: Record<WarrantyCoverage["type"], string> = {
  manufacturer: "Manufacturer (bumper-to-bumper)",
  powertrain: "Powertrain",
  extended: "Extended / service contract",
  emissions: "Emissions",
  component: "Component (engine, transmission, …)",
  aftermarket: "Aftermarket part",
  other: "Other",
};

export function coverageLabel(c: WarrantyCoverage): string {
  const bits = [COVERAGE_TYPE_LABEL[c.type] ?? c.type];
  if (c.provider) bits.push(c.provider);
  if (c.policyNumber) bits.push(`#${c.policyNumber}`);
  return bits.join(" · ");
}

// ---------------------------------------------------------------------------
// Service schedules
// ---------------------------------------------------------------------------

export function evaluateSchedule(
  s: ServiceSchedule,
  snap: VehicleSnapshot | undefined,
  workOrders: WorkOrder[],
  settings: Pick<Settings, "dueSoonFraction" | "units">,
  now = new Date()
): ScheduleEvaluation {
  const reasons: string[] = [];
  let progress: number | null = null;
  const consider = (p: number, text: string) => {
    reasons.push(text);
    if (progress == null || p > progress) progress = p;
  };

  if (s.intervalMeters != null && s.intervalMeters > 0) {
    if (snap?.odometerMeters != null && s.lastDoneMeters != null) {
      const used = snap.odometerMeters - s.lastDoneMeters;
      const p = used / s.intervalMeters;
      const left = s.intervalMeters - used;
      consider(p, left >= 0 ? `${formatDistance(left, settings.units)} until due` : `${formatDistance(-left, settings.units)} overdue`);
    } else if (snap?.odometerMeters != null && s.lastDoneMeters == null) {
      reasons.push("No odometer at last service — distance interval not checked");
    } else {
      reasons.push("No current odometer reading");
    }
  }
  if (s.intervalEngineSeconds != null && s.intervalEngineSeconds > 0) {
    if (snap?.engineSeconds != null && s.lastDoneEngineSeconds != null) {
      const used = snap.engineSeconds - s.lastDoneEngineSeconds;
      const p = used / s.intervalEngineSeconds;
      const left = s.intervalEngineSeconds - used;
      consider(p, left >= 0 ? `${formatHours(left)} until due` : `${formatHours(-left)} overdue`);
    } else if (snap?.engineSeconds != null) {
      reasons.push("No engine hours at last service — hours interval not checked");
    } else {
      reasons.push("No current engine-hours reading");
    }
  }
  if (s.intervalDays != null && s.intervalDays > 0) {
    const last = parseDate(s.lastDoneAt);
    if (last) {
      const used = daysBetween(last, now);
      const p = used / s.intervalDays;
      const left = s.intervalDays - used;
      consider(p, left >= 0 ? `${left} days until due` : `${-left} days overdue`);
    } else {
      reasons.push("No last-service date — time interval not checked");
    }
  }

  const open = workOrders.find(
    (w) => w.source.type === "schedule" && w.source.refId === s.id && (w.status === "open" || w.status === "in_progress" || w.status === "on_hold")
  );
  const openWorkOrderNumber = open ? open.number : null;

  let state: ScheduleEvaluation["state"] = "unknown";
  if (progress != null) {
    const p: number = progress;
    state = p >= 1 ? "overdue" : p >= settings.dueSoonFraction ? "due_soon" : "ok";
  }
  if (reasons.length === 0) reasons.push("No interval set");
  return { state, reasons, progress, openWorkOrderNumber };
}
