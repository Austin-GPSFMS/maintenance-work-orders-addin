/**
 * Pure merge + reminder maths for the Maintenance Center integration.
 *
 *  - mergeWorkOrders: Geotab MaintenanceWorkOrders (system of record for the
 *    header) ⨝ the add-in's AddInData "extras" (lines, warranty, claim,
 *    activity, category, due date) → one WorkOrder list.
 *  - buildReminderRows: every (reminder rule × vehicle in its groups) with
 *    the due state from the vehicle's last completed job + live readings.
 *
 * No API calls here — exercised by test/run.mjs.
 */

import type {
  ActivityEntry,
  GeotabDevice,
  GeotabMaintenanceWorkOrder,
  GeotabUser,
  ReminderJob,
  ReminderRule,
  ReminderVehicleRow,
  ScheduleEvaluation,
  ServiceSchedule,
  Settings,
  VehicleSnapshot,
  WorkOrder,
  WorkOrderPriority,
  WorkOrderStatus,
} from "../types";
import { splitNotes, timeSpanToSeconds } from "../api/maintenanceCenter";
import { daysBetween, parseDate, uid } from "./format";
import { userLabel } from "../api/geotab";
import { evaluateSchedule } from "./warranty";
import { ACTIVE_STATUSES, STATUS_ORDER } from "./workorders";

// ---------------------------------------------------------------------------
// Status / priority code mapping
// ---------------------------------------------------------------------------

/** Geotab statusCode → add-in status, preferring the local status when it maps to the same code. */
export function statusFromCode(code: number | undefined, local: WorkOrderStatus | null, map: Settings["statusCodeMap"]): WorkOrderStatus {
  if (code == null) return local ?? "open";
  if (local && map[local] === code) return local;
  const match = STATUS_ORDER.find((s) => map[s] === code);
  if (match) return match;
  // Unknown code: treat as active unless it is the completed code.
  return local && ACTIVE_STATUSES.includes(local) ? local : "open";
}

export function priorityFromCode(code: number | undefined, local: WorkOrderPriority | null, map: Settings["priorityCodeMap"]): WorkOrderPriority {
  if (code == null) return local ?? "medium";
  if (local && map[local] === code) return local;
  if (map.medium === code) return "medium"; // several priorities may share Geotab's default code
  const found = (Object.keys(map) as WorkOrderPriority[]).find((p) => map[p] === code);
  return found ?? local ?? "medium";
}

function idOf(v: { id: string; name?: string } | string | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.id ?? null;
}

function nameOf(v: { id: string; name?: string } | string | null | undefined): string {
  return v && typeof v !== "string" ? v.name ?? "" : "";
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export interface MergeInput {
  local: WorkOrder[];
  geotab: GeotabMaintenanceWorkOrder[];
  jobs: ReminderJob[];
  rules: ReminderRule[];
  devicesById: Map<string, GeotabDevice>;
  usersById: Map<string, GeotabUser>;
  settings: Settings;
}

export interface MergeOutput {
  workOrders: WorkOrder[];
  /** Local records whose Geotab order no longer exists (deleted in Maintenance Center). */
  orphaned: WorkOrder[];
}

/** A Geotab order with no AddInData record yet → a WorkOrder the editor can open; saving creates the record. */
export function workOrderFromGeotab(g: GeotabMaintenanceWorkOrder, jobs: ReminderJob[], rules: ReminderRule[], devicesById: Map<string, GeotabDevice>, usersById: Map<string, GeotabUser>, settings: Settings): WorkOrder {
  const deviceId = idOf(g.device) ?? "";
  const device = devicesById.get(deviceId);
  const myJobs = jobs.filter((j) => j.workOrderId === g.id);
  const job = myJobs[0];
  const rule = job?.scheduleId ? rules.find((r) => r.id === job.scheduleId) : undefined;
  const { title, description } = splitNotes(g.notes);
  const jobTitle = myJobs.map((j) => j.maintenanceTypeName).filter(Boolean).join(", ");
  const status = statusFromCode(g.statusCode, null, settings.statusCodeMap);
  const assigneeId = idOf(g.assignedTo);
  const assignee = assigneeId ? usersById.get(assigneeId) : undefined;
  const openedBy = nameOf(g.openedByUser) || (typeof g.openedByUser === "string" ? userLabel(usersById.get(g.openedByUser)) : "");
  const created = g.dateTime ?? new Date().toISOString();
  const activity: ActivityEntry[] = [{ at: created, by: openedBy || "MyGeotab", text: "Created in MyGeotab Maintenance Center" }];
  const lines: WorkOrder["lines"] = [];
  if (g.laborCost && g.laborCost > 0) lines.push({ id: uid("g"), type: "labor", description: "Labor (MyGeotab total)", qty: 1, unitCost: g.laborCost, warranty: false });
  if (g.partsCost && g.partsCost > 0) lines.push({ id: uid("g"), type: "part", description: "Parts (MyGeotab total)", qty: 1, unitCost: g.partsCost, warranty: false });
  const misc = (g.miscCost ?? 0) + (g.shippingCost ?? 0) + (g.taxCost ?? 0);
  if (misc > 0) lines.push({ id: uid("g"), type: "other", description: "Other / shipping / tax (MyGeotab)", qty: 1, unitCost: misc, warranty: false });
  const source: WorkOrder["source"] = job?.scheduleId
    ? { type: "schedule", refId: job.scheduleId, maintenanceTypeId: job.maintenanceTypeId ?? undefined, label: `Reminder — ${rule?.name ?? (job.maintenanceTypeName || "service")}` }
    : job?.defectId
      ? { type: "dvir", defectId: job.defectId, label: `DVIR defect — ${job.maintenanceTypeName || "defect report"}` }
      : { type: "manual", label: "Created in MyGeotab" };
  return {
    id: undefined,
    number: 0,
    deviceId,
    deviceName: device?.name ?? nameOf(g.device) ?? deviceId,
    title: title || jobTitle || "(untitled)",
    description,
    status,
    priority: priorityFromCode(g.priorityCode, null, settings.priorityCodeMap),
    category: job?.scheduleId ? "preventive" : job?.defectId ? "repair" : "other",
    assigneeId,
    assigneeName: assignee ? userLabel(assignee) : nameOf(g.assignedTo),
    vendor: "",
    invoiceNumber: "",
    createdAt: created,
    createdBy: openedBy || "MyGeotab",
    updatedAt: g.updatedDate ?? created,
    updatedBy: "MyGeotab",
    dueDate: null,
    startedAt: null,
    completedAt: g.completedDateTime ?? null,
    odometerAtOpen: g.odometerReading && g.odometerReading > 0 ? g.odometerReading : null,
    engineSecondsAtOpen: timeSpanToSeconds(g.engineHoursReading),
    odometerAtClose: status === "completed" && g.odometerReading ? g.odometerReading : null,
    engineSecondsAtClose: status === "completed" ? timeSpanToSeconds(g.engineHoursReading) : null,
    source,
    lines,
    warranty: {
      eligible: false,
      coverageId: null,
      coverageLabel: "",
      isWarrantyWork: false,
      claim: { status: "none", claimNumber: "", submittedAt: null, resolvedAt: null, amountClaimed: null, amountRecovered: null, notes: "" },
    },
    activity,
    geotab: { id: g.id, reference: g.reference ?? "", statusCode: g.statusCode ?? 1, jobId: job?.id ?? null },
  };
}

export function mergeWorkOrders({ local, geotab, jobs, rules, devicesById, usersById, settings }: MergeInput): MergeOutput {
  const byGeotabId = new Map<string, WorkOrder>();
  const unlinked: WorkOrder[] = [];
  for (const w of local) {
    if (w.geotab?.id) byGeotabId.set(w.geotab.id, w);
    else unlinked.push(w);
  }
  const out: WorkOrder[] = [];
  const seen = new Set<string>();
  for (const g of geotab) {
    seen.add(g.id);
    const l = byGeotabId.get(g.id);
    if (!l) {
      out.push(workOrderFromGeotab(g, jobs, rules, devicesById, usersById, settings));
      continue;
    }
    // Header fields follow Geotab; everything else is the add-in's.
    const status = statusFromCode(g.statusCode, l.status, settings.statusCodeMap);
    const assigneeId = idOf(g.assignedTo);
    const assignee = assigneeId ? usersById.get(assigneeId) : undefined;
    out.push({
      ...l,
      status,
      completedAt: status === "completed" ? (g.completedDateTime ?? l.completedAt) : l.status === "completed" ? null : l.completedAt,
      assigneeId: assigneeId ?? null,
      assigneeName: assignee ? userLabel(assignee) : assigneeId ? nameOf(g.assignedTo) || l.assigneeName : "",
      deviceName: devicesById.get(l.deviceId)?.name ?? l.deviceName,
      geotab: { id: g.id, reference: g.reference ?? l.geotab!.reference, statusCode: g.statusCode ?? l.geotab!.statusCode, jobId: l.geotab!.jobId ?? jobs.find((j) => j.workOrderId === g.id)?.id ?? null },
    });
  }
  const orphaned = local.filter((w) => w.geotab?.id && !seen.has(w.geotab.id));
  // Unsynced local orders stay visible so nothing is lost; the editor offers to sync them.
  out.push(...unlinked);
  return { workOrders: out, orphaned };
}

/** Display number: Geotab's reference when linked, else the add-in's own. */
export function displayNumber(wo: WorkOrder): string {
  if (wo.geotab?.reference) return `#${wo.geotab.reference}`;
  if (wo.number > 0) return `WO-${String(wo.number).padStart(5, "0")}`;
  return "#new";
}

// ---------------------------------------------------------------------------
// Reminders: rule × vehicle
// ---------------------------------------------------------------------------

export interface ReminderBuildInput {
  rules: ReminderRule[];
  devices: GeotabDevice[];
  /** Group ids (selected) → the set including descendants. */
  expand: (ids: string[]) => Set<string>;
  jobs: ReminderJob[];
  geotabById: Map<string, GeotabMaintenanceWorkOrder>;
  snapshots: Map<string, VehicleSnapshot>;
  settings: Settings;
  now?: Date;
}

const DAYS_PER_MONTH = 30.4375;

function evaluateOneOff(eventDate: string, lastDoneAt: string | null, settings: Settings, now: Date): ScheduleEvaluation {
  const due = parseDate(eventDate);
  if (!due) return { state: "unknown", reasons: ["Invalid event date"], progress: null, openWorkOrderNumber: null };
  if (lastDoneAt && new Date(lastDoneAt).getTime() >= due.getTime() - 30 * 86400000) {
    return { state: "ok", reasons: [`Done ${new Date(lastDoneAt).toLocaleDateString()} for the ${due.toLocaleDateString()} event`], progress: 1, openWorkOrderNumber: null };
  }
  const left = daysBetween(now, due);
  if (left < 0) return { state: "overdue", reasons: [`${-left} days past ${due.toLocaleDateString()}`], progress: 1 + -left / 365, openWorkOrderNumber: null };
  const soon = Math.round((1 - settings.dueSoonFraction) * 365);
  return { state: left <= Math.max(14, soon) ? "due_soon" : "ok", reasons: [`${left} days until ${due.toLocaleDateString()}`], progress: Math.max(0, 1 - left / 365), openWorkOrderNumber: null };
}

export function buildReminderRows({ rules, devices, expand, jobs, geotabById, snapshots, settings, now = new Date() }: ReminderBuildInput): ReminderVehicleRow[] {
  const completedCode = settings.statusCodeMap.completed;
  const jobsByKey = new Map<string, ReminderJob[]>();
  for (const j of jobs) {
    if (!j.scheduleId) continue;
    const k = `${j.scheduleId}|${j.deviceId}`;
    const list = jobsByKey.get(k);
    if (list) list.push(j);
    else jobsByKey.set(k, [j]);
  }
  const rows: ReminderVehicleRow[] = [];
  for (const rule of rules) {
    if (!rule.active) continue;
    const scoped = rule.groupIds.length ? (() => {
      const allowed = expand(rule.groupIds);
      return allowed.has("GroupCompanyId") ? devices : devices.filter((d) => (d.groups ?? []).some((g) => allowed.has(g.id)));
    })() : [];
    for (const d of scoped) {
      const myJobs = jobsByKey.get(`${rule.id}|${d.id}`) ?? [];
      let lastDone: ReminderVehicleRow["lastDone"] = null;
      let openWorkOrderId: string | null = null;
      for (const j of myJobs) {
        const wo = geotabById.get(j.workOrderId);
        const done = j.statusCode === completedCode || (wo?.statusCode === completedCode) || !!wo?.completedDateTime;
        if (done) {
          const at = wo?.completedDateTime ?? j.triggeredDate ?? wo?.dateTime ?? null;
          if (!lastDone || (at && (!lastDone.at || at > lastDone.at))) {
            lastDone = { at, odometerMeters: j.odometerMeters ?? (wo?.odometerReading && wo.odometerReading > 0 ? wo.odometerReading : null), engineSeconds: j.engineSeconds ?? (timeSpanToSeconds(wo?.engineHoursReading) || null) };
          }
        } else if (wo) {
          openWorkOrderId = wo.id;
        }
      }
      const snap = snapshots.get(d.id);
      let evaluation: ScheduleEvaluation;
      if (!rule.intervalMeters && !rule.intervalDays && !rule.intervalMonths && rule.eventDate) {
        evaluation = evaluateOneOff(rule.eventDate, lastDone?.at ?? null, settings, now);
      } else {
        const shape: ServiceSchedule = {
          id: rule.id,
          deviceId: d.id,
          deviceName: d.name ?? d.id,
          name: rule.name,
          category: "preventive",
          intervalMeters: rule.intervalMeters,
          intervalEngineSeconds: null,
          intervalDays: rule.intervalDays ?? (rule.intervalMonths ? Math.round(rule.intervalMonths * DAYS_PER_MONTH) : null),
          lastDoneAt: lastDone?.at ?? null,
          lastDoneMeters: lastDone?.odometerMeters ?? null,
          lastDoneEngineSeconds: lastDone?.engineSeconds ?? null,
          notes: "",
          createdAt: "",
          updatedAt: "",
        };
        evaluation = evaluateSchedule(shape, snap, [], settings, now);
        if (!lastDone) evaluation = { ...evaluation, reasons: ["No completed service on record in MyGeotab for this reminder", ...evaluation.reasons.filter((r) => !/last service/i.test(r))] };
      }
      rows.push({ key: `${rule.id}|${d.id}`, rule, deviceId: d.id, deviceName: d.name ?? d.id, evaluation, lastDone, openWorkOrderId });
    }
  }
  const order: Record<ScheduleEvaluation["state"], number> = { overdue: 0, due_soon: 1, unknown: 2, ok: 3 };
  rows.sort((a, b) => order[a.evaluation.state] - order[b.evaluation.state] || (b.evaluation.progress ?? 0) - (a.evaluation.progress ?? 0) || a.deviceName.localeCompare(b.deviceName, undefined, { numeric: true }));
  return rows;
}

/** Vehicle ids every active user rule applies to (for the readings sweep). */
export function vehiclesInAnyRule(rules: ReminderRule[], devices: GeotabDevice[], expand: (ids: string[]) => Set<string>): string[] {
  const out = new Set<string>();
  for (const rule of rules) {
    if (!rule.active || !rule.groupIds.length) continue;
    const allowed = expand(rule.groupIds);
    if (allowed.has("GroupCompanyId")) return devices.map((d) => d.id);
    for (const d of devices) if ((d.groups ?? []).some((g) => allowed.has(g.id))) out.add(d.id);
  }
  return Array.from(out);
}
