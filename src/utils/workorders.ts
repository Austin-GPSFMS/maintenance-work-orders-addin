/**
 * Work-order factories, labels, totals, filters and CSV export — pure.
 */

import type {
  ClaimStatus,
  DvirDefectItem,
  FaultItem,
  LineItem,
  LineType,
  ServiceSchedule,
  Settings,
  VehicleSnapshot,
  WarrantyCoverage,
  WorkOrder,
  WorkOrderCategory,
  WorkOrderPriority,
  WorkOrderStatus,
} from "../types";
import { formatDate, formatDateTime, formatDistance, formatMoney, parseDate, uid } from "./format";
import { activeCoverages, coverageLabel } from "./warranty";

export const STATUS_LABEL: Record<WorkOrderStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  on_hold: "On hold",
  completed: "Completed",
  cancelled: "Cancelled",
};
export const STATUS_ORDER: WorkOrderStatus[] = ["open", "in_progress", "on_hold", "completed", "cancelled"];
export const ACTIVE_STATUSES: WorkOrderStatus[] = ["open", "in_progress", "on_hold"];

export const PRIORITY_LABEL: Record<WorkOrderPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};
export const PRIORITY_ORDER: WorkOrderPriority[] = ["critical", "high", "medium", "low"];

export const CATEGORY_LABEL: Record<WorkOrderCategory, string> = {
  preventive: "Preventive maintenance",
  repair: "Repair",
  inspection: "Inspection",
  tires: "Tires & wheels",
  electrical: "Electrical",
  body: "Body & glass",
  recall: "Recall / campaign",
  telematics: "Telematics hardware",
  other: "Other",
};

export const LINE_TYPE_LABEL: Record<LineType, string> = {
  labor: "Labor",
  part: "Part",
  service: "Outside service",
  fee: "Fee / shop supplies",
  other: "Other",
};

export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  none: "No claim",
  pending: "To be filed",
  submitted: "Submitted",
  approved: "Approved",
  denied: "Denied",
  paid: "Paid",
};
export const CLAIM_ORDER: ClaimStatus[] = ["none", "pending", "submitted", "approved", "denied", "paid"];

export function formatNumber(n: number): string {
  return `WO-${String(n).padStart(5, "0")}`;
}

export function nextNumber(existing: WorkOrder[]): number {
  return existing.reduce((m, w) => Math.max(m, w.number), 0) + 1;
}

export function isActive(wo: WorkOrder): boolean {
  return ACTIVE_STATUSES.includes(wo.status);
}

export function isOverdue(wo: WorkOrder, now = new Date()): boolean {
  if (!isActive(wo) || !wo.dueDate) return false;
  const due = parseDate(wo.dueDate);
  if (!due) return false;
  due.setHours(23, 59, 59, 999);
  return due.getTime() < now.getTime();
}

export function lineTotal(l: LineItem): number {
  return (Number(l.qty) || 0) * (Number(l.unitCost) || 0);
}

export function totals(wo: WorkOrder): { total: number; warranty: number; fleet: number } {
  let total = 0;
  let warranty = 0;
  for (const l of wo.lines) {
    const t = lineTotal(l);
    total += t;
    if (l.warranty) warranty += t;
  }
  return { total, warranty, fleet: total - warranty };
}

export function newLine(type: LineType = "labor", description = "", warranty = false): LineItem {
  return { id: uid("l"), type, description, qty: 1, unitCost: 0, warranty };
}

export interface NewWorkOrderInput {
  deviceId: string;
  deviceName: string;
  by: string;
  existing: WorkOrder[];
  coverages: WarrantyCoverage[];
  snapshot: VehicleSnapshot | undefined;
  settings: Settings;
  now?: Date;
}

/** Blank order for a vehicle with the warranty eligibility already evaluated. */
export function createWorkOrder(input: NewWorkOrderInput): WorkOrder {
  const now = input.now ?? new Date();
  const iso = now.toISOString();
  const wo: WorkOrder = {
    number: nextNumber(input.existing),
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    title: "",
    description: "",
    status: "open",
    priority: "medium",
    category: "repair",
    assigneeId: null,
    assigneeName: "",
    vendor: "",
    invoiceNumber: "",
    createdAt: iso,
    createdBy: input.by,
    updatedAt: iso,
    updatedBy: input.by,
    dueDate: null,
    startedAt: null,
    completedAt: null,
    odometerAtOpen: input.snapshot?.odometerMeters ?? null,
    engineSecondsAtOpen: input.snapshot?.engineSeconds ?? null,
    odometerAtClose: null,
    engineSecondsAtClose: null,
    source: { type: "manual", label: "Manual entry" },
    lines: [],
    warranty: {
      eligible: false,
      coverageId: null,
      coverageLabel: "",
      isWarrantyWork: false,
      claim: { status: "none", claimNumber: "", submittedAt: null, resolvedAt: null, amountClaimed: null, amountRecovered: null, notes: "" },
    },
    activity: [{ at: iso, by: input.by, text: "Created" }],
  };
  return applyWarrantyEligibility(wo, input.coverages, input.snapshot, input.settings, now);
}

/** Re-evaluate eligibility (vehicle changed, coverage added); keeps the user's choices where set. */
export function applyWarrantyEligibility(
  wo: WorkOrder,
  coverages: WarrantyCoverage[],
  snapshot: VehicleSnapshot | undefined,
  settings: Settings,
  now = new Date()
): WorkOrder {
  const active = activeCoverages(wo.deviceId, coverages, snapshot, settings, now);
  const eligible = active.length > 0;
  const stillValid = wo.warranty.coverageId && active.some((a) => a.coverage.id === wo.warranty.coverageId);
  const pick = stillValid ? active.find((a) => a.coverage.id === wo.warranty.coverageId)! : active[0];
  return {
    ...wo,
    warranty: {
      ...wo.warranty,
      eligible,
      coverageId: pick ? (pick.coverage.id ?? null) : null,
      coverageLabel: pick ? coverageLabel(pick.coverage) : "",
      isWarrantyWork: wo.warranty.claim.status !== "none" ? wo.warranty.isWarrantyWork : eligible,
    },
  };
}

export function fromDvirDefect(wo: WorkOrder, item: DvirDefectItem): WorkOrder {
  const what = [item.defectName, item.partName].filter(Boolean).join(" — ");
  return {
    ...wo,
    title: what || "DVIR defect",
    description: [item.remarks, item.driverName ? `Reported by ${item.driverName}` : ""].filter(Boolean).join("\n"),
    category: "repair",
    priority: item.isSafeToOperate === false ? "critical" : "high",
    source: { type: "dvir", refId: item.logId, defectId: item.defectId, label: `DVIR ${formatDate(item.dateTime)} — ${what}` },
  };
}

export function fromFault(wo: WorkOrder, item: FaultItem): WorkOrder {
  const code = item.code ? `${item.code} ` : "";
  return {
    ...wo,
    title: `${code}${item.name}`.trim(),
    description: [item.description, item.recommendation ? `Recommendation: ${item.recommendation}` : "", item.failureMode ? `FMI: ${item.failureMode}` : "", item.controller ? `Controller: ${item.controller}` : ""]
      .filter(Boolean)
      .join("\n"),
    category: "repair",
    priority: item.lamps.includes("Red stop") ? "critical" : item.lamps.length ? "high" : "medium",
    source: { type: "fault", refId: item.faultId, diagnosticId: item.diagnosticId, label: `Fault ${code}${item.name} (${formatDate(item.dateTime)})` },
  };
}

export function fromSchedule(wo: WorkOrder, s: ServiceSchedule): WorkOrder {
  return {
    ...wo,
    title: s.name,
    description: s.notes,
    category: s.category,
    priority: "medium",
    source: { type: "schedule", refId: s.id, label: `Service schedule — ${s.name}` },
  };
}

/** Status change with the dates and activity it implies. */
export function transition(wo: WorkOrder, status: WorkOrderStatus, by: string, snapshot?: VehicleSnapshot, now = new Date()): WorkOrder {
  if (wo.status === status) return wo;
  const iso = now.toISOString();
  const next: WorkOrder = { ...wo, status, updatedAt: iso, updatedBy: by, activity: [...wo.activity, { at: iso, by, text: `${STATUS_LABEL[wo.status]} → ${STATUS_LABEL[status]}` }] };
  if (status === "in_progress" && !next.startedAt) next.startedAt = iso;
  if (status === "completed") {
    next.completedAt = iso;
    if (snapshot) {
      next.odometerAtClose = snapshot.odometerMeters ?? next.odometerAtClose;
      next.engineSecondsAtClose = snapshot.engineSeconds ?? next.engineSecondsAtClose;
    }
  }
  if (status !== "completed") next.completedAt = null;
  return next;
}

/** When a scheduled job completes, roll the schedule's "last done" forward. */
export function rollSchedule(s: ServiceSchedule, wo: WorkOrder, now = new Date()): ServiceSchedule {
  return {
    ...s,
    lastDoneAt: wo.completedAt ?? now.toISOString(),
    lastDoneMeters: wo.odometerAtClose ?? wo.odometerAtOpen ?? s.lastDoneMeters,
    lastDoneEngineSeconds: wo.engineSecondsAtClose ?? wo.engineSecondsAtOpen ?? s.lastDoneEngineSeconds,
    updatedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export type ViewFilter = "active" | "open" | "in_progress" | "on_hold" | "overdue" | "warranty" | "claims" | "completed" | "all";

export const VIEW_LABEL: Record<ViewFilter, string> = {
  active: "Active",
  open: "Open",
  in_progress: "In progress",
  on_hold: "On hold",
  overdue: "Overdue",
  warranty: "Warranty work",
  claims: "Claims open",
  completed: "Completed",
  all: "All",
};

export function matchesView(wo: WorkOrder, view: ViewFilter, now = new Date()): boolean {
  switch (view) {
    case "active":
      return isActive(wo);
    case "open":
    case "in_progress":
    case "on_hold":
    case "completed":
      return wo.status === view;
    case "overdue":
      return isOverdue(wo, now);
    case "warranty":
      return wo.warranty.isWarrantyWork;
    case "claims":
      return wo.warranty.claim.status === "pending" || wo.warranty.claim.status === "submitted";
    case "all":
      return true;
  }
}

export function matchesSearch(wo: WorkOrder, q: string): boolean {
  if (!q) return true;
  const hay = [formatNumber(wo.number), wo.deviceName, wo.title, wo.description, wo.assigneeName, wo.vendor, wo.invoiceNumber, wo.source.label, wo.warranty.claim.claimNumber]
    .join(" ")
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t));
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function workOrdersCsv(rows: WorkOrder[], settings: Settings): string {
  const head = [
    "Number", "Vehicle", "Title", "Status", "Priority", "Category", "Assignee", "Vendor", "Invoice", "Source",
    "Created", "Due", "Started", "Completed", "Odometer at open", "Odometer at close",
    "Warranty eligible", "Warranty work", "Coverage", "Claim status", "Claim #", "Amount claimed", "Amount recovered",
    "Total", "Warranty total", "Fleet total", "Lines", "Description",
  ];
  const lines = [head.join(",")];
  for (const w of rows) {
    const t = totals(w);
    lines.push(
      [
        formatNumber(w.number), w.deviceName, w.title, STATUS_LABEL[w.status], PRIORITY_LABEL[w.priority], CATEGORY_LABEL[w.category],
        w.assigneeName, w.vendor, w.invoiceNumber, w.source.label,
        formatDateTime(w.createdAt), formatDate(w.dueDate), formatDateTime(w.startedAt), formatDateTime(w.completedAt),
        formatDistance(w.odometerAtOpen, settings.units), formatDistance(w.odometerAtClose, settings.units),
        w.warranty.eligible ? "yes" : "no", w.warranty.isWarrantyWork ? "yes" : "no", w.warranty.coverageLabel,
        CLAIM_STATUS_LABEL[w.warranty.claim.status], w.warranty.claim.claimNumber,
        w.warranty.claim.amountClaimed ?? "", w.warranty.claim.amountRecovered ?? "",
        t.total.toFixed(2), t.warranty.toFixed(2), t.fleet.toFixed(2),
        w.lines.map((l) => `${LINE_TYPE_LABEL[l.type]}: ${l.description} ×${l.qty} @ ${formatMoney(l.unitCost, settings.currency)}${l.warranty ? " [warranty]" : ""}`).join(" | "),
        w.description,
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\n");
}

export function downloadText(filename: string, text: string, mime = "text/csv"): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
