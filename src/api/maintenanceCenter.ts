/**
 * Geotab Maintenance Center — the UNDOCUMENTED types behind MyGeotab's
 * Maintenance → Reminders / Work orders pages:
 *
 *   MaintenanceSchedule       reminder rule (group-scoped; kilometers / months / days / eventDate)
 *   MaintenanceWorkOrder      work order header (reference, statusCode, priorityCode, notes, readings, costs)
 *   MaintenanceWorkOrderJob   job on an order (schedule → maintenanceType; or a DVIR "Defect Report")
 *
 * Confirmed on gpsfms_pilot 2026-10-28 (tools/probe_*.py): Get / GetFeed /
 * Add / Set / Remove all work with a normal admin session. statusCode 1 =
 * open and 5 = completed are confirmed; other codes are mapped through
 * Settings. The server rejects dateTime values in the future, so every
 * timestamp we send is backdated a minute. Status / device search filters
 * are silently IGNORED by the server, so everything is fetched and filtered
 * client-side (GetFeed is available for incremental loads later).
 *
 * Geotab's note on this surface: "undocumented, subject to change without
 * notice" — every call here is isolated so the add-in can fall back to its
 * AddInData-only mode (Settings → Sync to MyGeotab off) if it ever breaks.
 */

import type {
  GeotabApi,
  GeotabDevice,
  GeotabMaintenanceJob,
  GeotabMaintenanceSchedule,
  GeotabMaintenanceType,
  GeotabMaintenanceWorkOrder,
  GeotabStatusData,
  ReminderJob,
  ReminderRule,
  Settings,
  VehicleSnapshot,
  WorkOrder,
} from "../types";
import { apiCall, apiMultiCall, ENGINE_HOURS_ADJ, ODOMETER_ADJ, Pacer } from "./geotab";
import { totals } from "../utils/workorders";

const RESULTS_LIMIT = 50000;

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

function idOf(v: { id: string } | string | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.id ?? null;
}

export function normalizeSchedule(raw: GeotabMaintenanceSchedule): ReminderRule {
  const mt = raw.maintenanceType ?? null;
  return {
    id: raw.id,
    name: (raw.name ?? mt?.name ?? raw.id).trim(),
    active: raw.active !== false,
    source: String(raw.source ?? "manual"),
    groupIds: (raw.groups ?? []).map((g) => g.id).filter(Boolean),
    labels: (raw.labels ?? []).map((l) => String(l)).filter((l) => l.trim().length > 0),
    intervalMeters: typeof raw.kilometers === "number" && raw.kilometers > 0 ? raw.kilometers * 1000 : null,
    intervalDays: typeof raw.days === "number" && raw.days > 0 ? raw.days : null,
    intervalMonths: typeof raw.months === "number" && raw.months > 0 ? raw.months : null,
    eventDate: raw.eventDate ?? null,
    maintenanceTypeId: mt?.id ?? null,
    maintenanceTypeName: mt?.name ?? "",
    maintenanceType: mt,
  };
}

/** Geotab's own Data Insight rules (Oil Life, ESR) are not user reminders. */
export function isUserReminder(r: ReminderRule): boolean {
  return r.source.toLowerCase() === "manual" || r.source.toLowerCase() === "scheduled";
}

/** "d.hh:mm:ss" or "hh:mm:ss" → seconds. */
export function timeSpanToSeconds(v: string | undefined | null): number | null {
  if (!v) return null;
  const m = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})/.exec(v.trim());
  if (!m) return null;
  const [, d, h, mi, s] = m;
  return (d ? parseInt(d, 10) * 86400 : 0) + parseInt(h, 10) * 3600 + parseInt(mi, 10) * 60 + parseInt(s, 10);
}

/** seconds → "d.hh:mm:ss" (Geotab TimeSpan). */
export function secondsToTimeSpan(seconds: number | null | undefined): string {
  const t = Math.max(0, Math.round(seconds ?? 0));
  const d = Math.floor(t / 86400);
  const h = Math.floor((t % 86400) / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const hms = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return d ? `${d}.${hms}` : hms;
}

export function normalizeJob(raw: GeotabMaintenanceJob): ReminderJob | null {
  const workOrderId = idOf(raw.workOrder);
  const deviceId = idOf(raw.device);
  if (!raw.id || !workOrderId || !deviceId) return null;
  const mt = raw.maintenanceType;
  const hoursFromField = typeof raw.engineHoursReadingInHours === "number" && raw.engineHoursReadingInHours > 0 ? raw.engineHoursReadingInHours * 3600 : null;
  const spanSeconds = timeSpanToSeconds(raw.engineHoursReading);
  return {
    id: raw.id,
    workOrderId,
    scheduleId: idOf(raw.schedule),
    deviceId,
    maintenanceTypeId: mt?.id ?? null,
    maintenanceTypeName: mt?.name ?? "",
    defectId: mt?.defect?.id ?? null,
    statusCode: typeof raw.statusCode === "number" ? raw.statusCode : 1,
    severityCode: typeof raw.severityCode === "number" ? raw.severityCode : 100,
    triggeredDate: raw.triggeredDate ?? raw.dateTime ?? null,
    odometerMeters: typeof raw.odometerReading === "number" && raw.odometerReading > 0 ? raw.odometerReading : null,
    engineSeconds: spanSeconds && spanSeconds > 0 ? spanSeconds : hoursFromField,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function fetchSchedules(api: GeotabApi, pacer: Pacer): Promise<ReminderRule[]> {
  await pacer.reserve(1);
  const rows = await apiCall<GeotabMaintenanceSchedule[]>(api, "Get", { typeName: "MaintenanceSchedule", resultsLimit: 5000 });
  return rows.filter((r) => r && r.id).map(normalizeSchedule);
}

export async function fetchGeotabWorkOrders(api: GeotabApi, pacer: Pacer): Promise<GeotabMaintenanceWorkOrder[]> {
  await pacer.reserve(1);
  const rows = await apiCall<GeotabMaintenanceWorkOrder[]>(api, "Get", { typeName: "MaintenanceWorkOrder", resultsLimit: RESULTS_LIMIT });
  return rows.filter((r) => r && r.id);
}

export async function fetchJobs(api: GeotabApi, pacer: Pacer): Promise<ReminderJob[]> {
  await pacer.reserve(1);
  const rows = await apiCall<GeotabMaintenanceJob[]>(api, "Get", { typeName: "MaintenanceWorkOrderJob", resultsLimit: RESULTS_LIMIT });
  return rows.map(normalizeJob).filter((j): j is ReminderJob => j != null);
}

export async function fetchGeotabWorkOrder(api: GeotabApi, pacer: Pacer, id: string): Promise<GeotabMaintenanceWorkOrder | null> {
  await pacer.reserve(1);
  const rows = await apiCall<GeotabMaintenanceWorkOrder[]>(api, "Get", { typeName: "MaintenanceWorkOrder", search: { id }, resultsLimit: 1 });
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Never send a timestamp the server could consider "in the future". */
function safePast(d: Date = new Date()): string {
  return new Date(d.getTime() - 60_000).toISOString();
}

/** Geotab wants currency codes Pascal-cased ("Usd", "Cad"). */
function currencyCode(iso: string): string {
  const c = (iso || "USD").toUpperCase();
  return c[0] + c.slice(1).toLowerCase();
}

/** Geotab has no title field: notes = title + blank line + description (+ source line). */
/** Separates the user's text from the lines the add-in appends (source, vendor, warranty). */
export const NOTES_MARKER = "——";

export function composeNotes(wo: WorkOrder, warrantyNote = ""): string {
  const parts = [wo.title.trim()];
  if (wo.description.trim()) parts.push("", wo.description.trim());
  const meta: string[] = [];
  if (wo.source.type !== "manual" && wo.source.type !== "schedule") meta.push(`Source: ${wo.source.label}`);
  if (wo.vendor.trim()) meta.push(`Vendor: ${wo.vendor.trim()}${wo.invoiceNumber ? ` · Invoice ${wo.invoiceNumber}` : ""}`);
  if (warrantyNote.trim()) meta.push(warrantyNote.trim());
  if (meta.length) parts.push("", NOTES_MARKER, ...meta);
  return parts.join("\n");
}

/** First line of Geotab notes = title, rest = description (inverse of composeNotes). */
export function splitNotes(notes: string | null | undefined): { title: string; description: string } {
  let text = (notes ?? "").replace(/\r/g, "").trim();
  if (!text) return { title: "", description: "" };
  // Drop the add-in's own appended block (marker, or legacy trailing Source:/Vendor:/Warranty: lines).
  const marker = text.indexOf(`\n${NOTES_MARKER}\n`);
  if (marker >= 0) text = text.slice(0, marker).trim();
  else {
    const kept = text.split("\n");
    while (kept.length > 1 && /^(Source|Vendor|Warranty|Claim|Not claimed)\b/.test(kept[kept.length - 1].trim())) kept.pop();
    text = kept.join("\n").trim();
  }
  const [first, ...rest] = text.split("\n");
  return { title: first.trim(), description: rest.join("\n").trim() };
}

function headerEntity(wo: WorkOrder, settings: Settings, snapshot: VehicleSnapshot | undefined, existing?: GeotabMaintenanceWorkOrder, warrantyNote = ""): Record<string, unknown> {
  const t = totals(wo);
  const odo = wo.odometerAtClose ?? wo.odometerAtOpen ?? snapshot?.odometerMeters ?? existing?.odometerReading ?? 0;
  const hrs = wo.engineSecondsAtClose ?? wo.engineSecondsAtOpen ?? snapshot?.engineSeconds ?? timeSpanToSeconds(existing?.engineHoursReading) ?? 0;
  const labor = wo.lines.filter((l) => l.type === "labor").reduce((s, l) => s + l.qty * l.unitCost, 0);
  const parts = wo.lines.filter((l) => l.type === "part").reduce((s, l) => s + l.qty * l.unitCost, 0);
  const misc = t.total - labor - parts;
  const entity: Record<string, unknown> = {
    ...(existing ?? {}),
    device: { id: wo.deviceId },
    dateTime: existing?.dateTime ?? safePast(new Date(wo.createdAt)),
    priorityCode: settings.priorityCodeMap[wo.priority] ?? 100,
    statusCode: settings.statusCodeMap[wo.status] ?? 1,
    notes: composeNotes(wo, warrantyNote),
    odometerReading: Math.round(odo),
    engineHoursReading: secondsToTimeSpan(hrs),
    engineHoursReadingInHours: Math.round(hrs / 3600),
    costCurrency: existing?.costCurrency ?? currencyCode(settings.currency),
    laborCost: Math.round(labor * 100) / 100,
    partsCost: Math.round(parts * 100) / 100,
    miscCost: Math.round(Math.max(0, misc) * 100) / 100,
    taxAddedToTotal: existing?.taxAddedToTotal ?? true,
    completedDateTime: wo.status === "completed" ? safePast(new Date(wo.completedAt ?? Date.now())) : null,
  };
  // assignedTo: send the user id, or clear it.
  entity.assignedTo = wo.assigneeId ? { id: wo.assigneeId } : null;
  if (existing?.reference) entity.reference = existing.reference;
  delete (entity as { version?: unknown }).version; // let the server bump it
  return entity;
}

function jobEntity(wo: WorkOrder, rule: ReminderRule, settings: Settings): Record<string, unknown> | null {
  if (!rule.maintenanceType) return null;
  const mt: GeotabMaintenanceType = rule.maintenanceType;
  const when = safePast(new Date(wo.createdAt));
  return {
    device: { id: wo.deviceId },
    schedule: { id: rule.id },
    severityCode: settings.severityCodeMap[wo.priority] ?? 100,
    statusCode: settings.statusCodeMap[wo.status] ?? 1,
    triggeredDate: when,
    dateTime: when,
    maintenanceType: {
      id: mt.id,
      name: mt.name,
      source: mt.source,
      customSource: mt.customSource,
      sourceType: mt.sourceType,
      createdBy: typeof mt.createdBy === "string" ? { id: mt.createdBy } : mt.createdBy,
      ...(mt.defect ? { defect: mt.defect } : {}),
    },
  };
}

export interface GeotabCreateResult {
  id: string;
  reference: string;
  statusCode: number;
  jobId: string | null;
}

/**
 * Add a MaintenanceWorkOrder (plus a job when the order came from a
 * reminder rule). Returns Geotab's id and the reference it assigned.
 */
export async function createGeotabWorkOrder(
  api: GeotabApi,
  pacer: Pacer,
  wo: WorkOrder,
  settings: Settings,
  snapshot: VehicleSnapshot | undefined,
  rule: ReminderRule | null,
  warrantyNote = ""
): Promise<GeotabCreateResult> {
  const entity = headerEntity(wo, settings, snapshot, undefined, warrantyNote);
  const job = rule ? jobEntity(wo, rule, settings) : null;
  if (job) {
    entity.jobCount = 1;
    entity.workJobs = [job];
  }
  await pacer.reserve(1);
  const id = await apiCall<string>(api, "Add", { typeName: "MaintenanceWorkOrder", entity });
  const saved = await fetchGeotabWorkOrder(api, pacer, id);
  return { id, reference: saved?.reference ?? "", statusCode: saved?.statusCode ?? (entity.statusCode as number), jobId: null };
}

/** Re-read, patch, Set. Returns the refreshed header. */
export async function updateGeotabWorkOrder(
  api: GeotabApi,
  pacer: Pacer,
  wo: WorkOrder,
  settings: Settings,
  snapshot: VehicleSnapshot | undefined,
  warrantyNote = ""
): Promise<GeotabCreateResult> {
  if (!wo.geotab) throw new Error("Work order is not linked to a Geotab order.");
  const existing = await fetchGeotabWorkOrder(api, pacer, wo.geotab.id);
  if (!existing) throw new Error(`Geotab work order ${wo.geotab.reference || wo.geotab.id} no longer exists.`);
  const entity = { ...headerEntity(wo, settings, snapshot, existing, warrantyNote), id: existing.id };
  await pacer.reserve(1);
  await apiCall(api, "Set", { typeName: "MaintenanceWorkOrder", entity });
  const saved = await fetchGeotabWorkOrder(api, pacer, existing.id);
  return { id: existing.id, reference: saved?.reference ?? existing.reference ?? "", statusCode: saved?.statusCode ?? (settings.statusCodeMap[wo.status] ?? 1), jobId: wo.geotab.jobId };
}

export async function removeGeotabWorkOrder(api: GeotabApi, pacer: Pacer, id: string): Promise<void> {
  await pacer.reserve(1);
  await apiCall(api, "Remove", { typeName: "MaintenanceWorkOrder", entity: { id } });
}

// ---------------------------------------------------------------------------
// Fleet-wide readings sweep (ported from vehicle-replacement-planner-addin):
// a handful of windowed StatusData calls for the whole fleet instead of two
// calls per vehicle — reminders are group-scoped, so "every vehicle" is the
// normal case.
// ---------------------------------------------------------------------------

const DAY = 86400000;
const WINDOWS: Array<[number, number]> = [
  [-0.5, 0],
  [-3, -0.5],
  [-14, -3],
];
const MAX_PAGES = 12;
const DEEP_BATCH = 50;
let propertySelectorOk: boolean | null = null;

async function fetchWindow(
  api: GeotabApi,
  pacer: Pacer,
  diagnostic: string,
  from: Date,
  to: Date,
  shouldCancel?: () => boolean
): Promise<GeotabStatusData[]> {
  const out: GeotabStatusData[] = [];
  let cursor = from.getTime();
  const end = to.getTime();
  let page = 0;
  while (cursor < end && page < MAX_PAGES) {
    if (shouldCancel?.()) throw new Error("Cancelled");
    page += 1;
    await pacer.reserve(1, shouldCancel);
    const base = { typeName: "StatusData", search: { diagnosticSearch: { id: diagnostic }, fromDate: new Date(cursor).toISOString(), toDate: to.toISOString() }, resultsLimit: RESULTS_LIMIT };
    let rows: GeotabStatusData[];
    if (propertySelectorOk !== false) {
      try {
        rows = await apiCall<GeotabStatusData[]>(api, "Get", { ...base, propertySelector: { fields: ["device", "diagnostic", "dateTime", "data"], isIncluded: true } });
        propertySelectorOk = true;
      } catch (e) {
        if (propertySelectorOk === true) throw e;
        propertySelectorOk = false;
        await pacer.reserve(1, shouldCancel);
        rows = await apiCall<GeotabStatusData[]>(api, "Get", base);
      }
    } else {
      rows = await apiCall<GeotabStatusData[]>(api, "Get", base);
    }
    out.push(...rows);
    if (rows.length < RESULTS_LIMIT) break;
    let last = cursor;
    for (const r of rows) {
      const t = r.dateTime ? new Date(r.dateTime).getTime() : NaN;
      if (t > last) last = t;
    }
    cursor = Math.max(last, cursor + 1);
  }
  return out;
}

/**
 * Latest adjusted odometer + engine hours for every device in `deviceIds`:
 * fleet-wide windows (−12 h, −3 d, −14 d) per diagnostic, then one
 * per-device call for whatever is still missing, capped by `deepMax`.
 */
export async function sweepSnapshots(
  api: GeotabApi,
  deviceIds: string[],
  pacer: Pacer,
  onProgress: (text: string, pct: number | null) => void,
  deepMax = 300,
  shouldCancel?: () => boolean
): Promise<Map<string, VehicleSnapshot>> {
  const wanted = new Set(deviceIds);
  const out = new Map<string, VehicleSnapshot>();
  const get = (id: string) => {
    let s = out.get(id);
    if (!s) {
      s = { deviceId: id, odometerMeters: null, odometerAt: null, engineSeconds: null, engineAt: null };
      out.set(id, s);
    }
    return s;
  };
  const now = Date.now();
  const absorb = (rows: GeotabStatusData[], diagnostic: string) => {
    for (const r of rows) {
      const id = r.device?.id;
      if (!id || !wanted.has(id) || typeof r.data !== "number" || !r.dateTime) continue;
      if (r.diagnostic?.id && r.diagnostic.id !== diagnostic) continue;
      const t = new Date(r.dateTime).getTime();
      if (!Number.isFinite(t) || t > now + 60000) continue;
      const s = get(id);
      if (diagnostic === ODOMETER_ADJ) {
        if (s.odometerAt == null || t > new Date(s.odometerAt).getTime()) {
          s.odometerMeters = r.data;
          s.odometerAt = new Date(t).toISOString();
        }
      } else if (s.engineAt == null || t > new Date(s.engineAt).getTime()) {
        s.engineSeconds = r.data;
        s.engineAt = new Date(t).toISOString();
      }
    }
  };
  const covered = (diag: string) => {
    let n = 0;
    for (const id of wanted) {
      const s = out.get(id);
      if (s && (diag === ODOMETER_ADJ ? s.odometerAt : s.engineAt)) n += 1;
    }
    return n;
  };

  for (const [diag, label] of [
    [ODOMETER_ADJ, "odometer"],
    [ENGINE_HOURS_ADJ, "engine hours"],
  ] as const) {
    for (let w = 0; w < WINDOWS.length; w++) {
      if (covered(diag) >= wanted.size) break;
      const [a, b] = WINDOWS[w];
      onProgress(`Reading ${label} fleet-wide — window ${w + 1}/${WINDOWS.length} (${covered(diag).toLocaleString()} / ${wanted.size.toLocaleString()} vehicles so far)…`, Math.round((covered(diag) / Math.max(1, wanted.size)) * 100));
      const rows = await fetchWindow(api, pacer, diag, new Date(now + a * DAY), new Date(Math.min(now + b * DAY, now)), shouldCancel);
      absorb(rows, diag);
    }
  }

  // Per-device fallback for vehicles silent across every window (capped).
  const missing = deviceIds.filter((id) => !out.get(id)?.odometerAt).slice(0, Math.max(0, deepMax));
  const at = new Date().toISOString();
  for (let i = 0; i < missing.length; i += DEEP_BATCH) {
    if (shouldCancel?.()) throw new Error("Cancelled");
    const batch = missing.slice(i, i + DEEP_BATCH);
    onProgress(`Looking up ${Math.min(i + batch.length, missing.length)} / ${missing.length} quiet vehicles individually…`, Math.round(((i + batch.length) / missing.length) * 100));
    const calls: Array<[string, unknown]> = [];
    for (const id of batch) {
      for (const diag of [ODOMETER_ADJ, ENGINE_HOURS_ADJ]) {
        calls.push(["Get", { typeName: "StatusData", search: { deviceSearch: { id }, diagnosticSearch: { id: diag }, fromDate: at, toDate: at }, resultsLimit: 10 }]);
      }
    }
    await pacer.reserve(calls.length, shouldCancel);
    const results = await apiMultiCall<GeotabStatusData[]>(api, calls);
    batch.forEach((id, idx) => {
      absorb((results[idx * 2] ?? []).map((r) => ({ ...r, device: r.device ?? { id } })), ODOMETER_ADJ);
      absorb((results[idx * 2 + 1] ?? []).map((r) => ({ ...r, device: r.device ?? { id } })), ENGINE_HOURS_ADJ);
    });
  }
  for (const id of wanted) get(id); // every requested vehicle gets an entry, even if empty
  return out;
}

/** Device ids a reminder rule applies to (its groups + descendants). */
export function devicesForRule(rule: ReminderRule, devices: GeotabDevice[], expand: (ids: string[]) => Set<string>): GeotabDevice[] {
  if (!rule.groupIds.length) return [];
  const allowed = expand(rule.groupIds);
  if (allowed.has("GroupCompanyId")) return devices;
  return devices.filter((d) => (d.groups ?? []).some((g) => allowed.has(g.id)));
}

// ---------------------------------------------------------------------------
// Client facade — one object App talks to, with a live and a demo version.
// ---------------------------------------------------------------------------

export interface MaintenanceSnapshot {
  rules: ReminderRule[];
  orders: GeotabMaintenanceWorkOrder[];
  jobs: ReminderJob[];
}

export interface MaintenanceClient {
  readonly label: string;
  loadAll(): Promise<MaintenanceSnapshot>;
  create(wo: WorkOrder, settings: Settings, snapshot: VehicleSnapshot | undefined, rule: ReminderRule | null, warrantyNote?: string): Promise<GeotabCreateResult>;
  update(wo: WorkOrder, settings: Settings, snapshot: VehicleSnapshot | undefined, warrantyNote?: string): Promise<GeotabCreateResult>;
  remove(id: string): Promise<void>;
  /** Fresh copy of one order header after a write (null if gone). */
  getOrder(id: string): Promise<GeotabMaintenanceWorkOrder | null>;
  /** Jobs on one order (after a create, to pick up the job Geotab made). */
  getJobs(workOrderId: string): Promise<ReminderJob[]>;
}

export class LiveMaintenanceClient implements MaintenanceClient {
  readonly label = "MyGeotab Maintenance Center";
  constructor(private api: GeotabApi, private pacer: Pacer) {}
  async loadAll(): Promise<MaintenanceSnapshot> {
    const [rules, orders, jobs] = await Promise.all([fetchSchedules(this.api, this.pacer), fetchGeotabWorkOrders(this.api, this.pacer), fetchJobs(this.api, this.pacer)]);
    return { rules, orders, jobs };
  }
  create(wo: WorkOrder, settings: Settings, snapshot: VehicleSnapshot | undefined, rule: ReminderRule | null, warrantyNote = "") {
    return createGeotabWorkOrder(this.api, this.pacer, wo, settings, snapshot, rule, warrantyNote);
  }
  update(wo: WorkOrder, settings: Settings, snapshot: VehicleSnapshot | undefined, warrantyNote = "") {
    return updateGeotabWorkOrder(this.api, this.pacer, wo, settings, snapshot, warrantyNote);
  }
  remove(id: string) {
    return removeGeotabWorkOrder(this.api, this.pacer, id);
  }
  getOrder(id: string) {
    return fetchGeotabWorkOrder(this.api, this.pacer, id);
  }
  async getJobs(workOrderId: string) {
    return (await fetchJobs(this.api, this.pacer)).filter((j) => j.workOrderId === workOrderId);
  }
}

/** In-memory stand-in for the standalone preview / smoke test. */
export class DemoMaintenanceClient implements MaintenanceClient {
  readonly label = "demo Maintenance Center (in-memory)";
  private seq = 900;
  constructor(private schedules: GeotabMaintenanceSchedule[], private orders: GeotabMaintenanceWorkOrder[], private jobs: GeotabMaintenanceJob[]) {}
  private delay() {
    return new Promise((r) => setTimeout(r, 80));
  }
  async loadAll(): Promise<MaintenanceSnapshot> {
    await this.delay();
    return { rules: this.schedules.map(normalizeSchedule), orders: this.orders.map((o) => ({ ...o })), jobs: this.jobs.map(normalizeJob).filter((j): j is ReminderJob => j != null) };
  }
  async create(wo: WorkOrder, settings: Settings, snapshot: VehicleSnapshot | undefined, rule: ReminderRule | null, warrantyNote = ""): Promise<GeotabCreateResult> {
    await this.delay();
    this.seq += 1;
    const id = `gwo-${this.seq}`;
    const reference = String(this.seq).padStart(6, "0");
    const header = { ...(headerEntity(wo, settings, snapshot, undefined, warrantyNote) as unknown as GeotabMaintenanceWorkOrder), id, reference, updatedDate: new Date().toISOString(), openedByUser: { id: "demo", name: "demo.user" } };
    this.orders.push(header);
    let jobId: string | null = null;
    if (rule?.maintenanceType) {
      jobId = `job-${this.seq}`;
      this.jobs.push({ id: jobId, workOrder: { id }, schedule: { id: rule.id }, device: { id: wo.deviceId }, maintenanceType: rule.maintenanceType, statusCode: header.statusCode, severityCode: settings.severityCodeMap[wo.priority], triggeredDate: header.dateTime });
    }
    return { id, reference, statusCode: header.statusCode ?? 1, jobId };
  }
  async update(wo: WorkOrder, settings: Settings, snapshot: VehicleSnapshot | undefined, warrantyNote = ""): Promise<GeotabCreateResult> {
    await this.delay();
    if (!wo.geotab) throw new Error("not linked");
    const idx = this.orders.findIndex((o) => o.id === wo.geotab!.id);
    if (idx < 0) throw new Error(`Geotab work order ${wo.geotab.reference} no longer exists.`);
    const existing = this.orders[idx];
    this.orders[idx] = { ...(headerEntity(wo, settings, snapshot, existing, warrantyNote) as unknown as GeotabMaintenanceWorkOrder), id: existing.id, reference: existing.reference, updatedDate: new Date().toISOString() };
    for (const j of this.jobs) if (j.workOrder?.id === existing.id) j.statusCode = this.orders[idx].statusCode;
    return { id: existing.id, reference: existing.reference ?? "", statusCode: this.orders[idx].statusCode ?? 1, jobId: wo.geotab.jobId };
  }
  async remove(id: string) {
    await this.delay();
    const i = this.orders.findIndex((o) => o.id === id);
    if (i >= 0) this.orders.splice(i, 1);
    for (let k = this.jobs.length - 1; k >= 0; k--) if (this.jobs[k].workOrder?.id === id) this.jobs.splice(k, 1);
  }
  async getOrder(id: string) {
    await this.delay();
    return this.orders.find((o) => o.id === id) ?? null;
  }
  async getJobs(workOrderId: string) {
    return this.jobs.filter((j) => j.workOrder?.id === workOrderId).map(normalizeJob).filter((j): j is ReminderJob => j != null);
  }
}
