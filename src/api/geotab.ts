/**
 * Promise-based wrappers around the MyGeotab Add-In `api.call` interface.
 *
 * Mirrors vehicle-replacement-planner-addin/src/api/geotab.ts: every call goes
 * through `apiCall` / `apiMultiCall` so there is one place to pace requests
 * and surface typed errors. The `Pacer` keeps the rolling one-minute call
 * count under the configured cap (MyGeotab allows ~1000/user/minute and every
 * child of a multiCall counts individually).
 */

import type {
  DvirDefectItem,
  FaultItem,
  GeotabApi,
  GeotabDevice,
  GeotabDvirDefect,
  GeotabDvirLog,
  GeotabFaultData,
  GeotabGroup,
  GeotabSession,
  GeotabStatusData,
  GeotabUser,
  VehicleSnapshot,
} from "../types";

const INTER_CALL_DELAY_MS = 40;
const RESULTS_LIMIT = 50000;
/** Devices per multiCall when reading odometer / engine hours. */
const SNAPSHOT_BATCH = 50;

/** What MyGeotab shows as the vehicle's odometer (raw × factor + manual adjustments). */
export const ODOMETER_ADJ = "DiagnosticOdometerAdjustmentId";
/** What MyGeotab shows as engine hours (seconds). */
export const ENGINE_HOURS_ADJ = "DiagnosticEngineHoursAdjustmentId";

const DEVICE_FIELDS = [
  "id",
  "name",
  "serialNumber",
  "deviceType",
  "activeFrom",
  "activeTo",
  "groups",
  "licensePlate",
  "vehicleIdentificationNumber",
  "engineVehicleIdentificationNumber",
];

// ---------------------------------------------------------------------------
// Rate pacing
// ---------------------------------------------------------------------------

export class Pacer {
  private stamps: number[] = [];
  public total = 0;
  constructor(public perMinute: number) {}

  /** Wait until `n` more calls fit in the rolling 60 s window, then book them. */
  async reserve(n: number, shouldCancel?: () => boolean): Promise<void> {
    const cap = Math.max(50, this.perMinute);
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => now - t < 60000);
      if (this.stamps.length + n <= cap) break;
      if (shouldCancel?.()) throw new Error("Cancelled");
      const oldest = this.stamps[0];
      const wait = Math.min(5000, Math.max(250, 60000 - (now - oldest) + 50));
      await new Promise((r) => setTimeout(r, wait));
    }
    const t = Date.now();
    for (let i = 0; i < n; i++) this.stamps.push(t);
    this.total += n;
  }
}

// ---------------------------------------------------------------------------
// Low-level call helpers
// ---------------------------------------------------------------------------

export function apiCall<T = unknown>(api: GeotabApi, method: string, params: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      api.call(
        method,
        params,
        (result) => setTimeout(() => resolve(result as T), INTER_CALL_DELAY_MS),
        (err) => reject(err)
      );
    } catch (err) {
      reject(err);
    }
  });
}

export function apiMultiCall<T = unknown>(api: GeotabApi, calls: Array<[string, unknown]>): Promise<T[]> {
  if (calls.length === 0) return Promise.resolve([]);
  if (typeof api.multiCall !== "function") {
    return calls.reduce<Promise<T[]>>(
      (p, c) => p.then((acc) => apiCall<T>(api, c[0], c[1]).then((r) => [...acc, r])),
      Promise.resolve([])
    );
  }
  return new Promise((resolve, reject) => {
    try {
      api.multiCall!(
        calls,
        (result) => setTimeout(() => resolve(result as T[]), INTER_CALL_DELAY_MS),
        (err) => reject(err)
      );
    } catch (err) {
      reject(err);
    }
  });
}

export function friendlyError(err: unknown): string {
  if (err == null) return "Unknown error.";
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const e = err as { name?: string; message?: string };
    if (e.name === "InvalidUserException" || /InvalidUser/i.test(String(err))) {
      return "Session expired — refresh the MyGeotab page to re-authenticate.";
    }
    if (/quota/i.test(e.message ?? "")) {
      return `${e.message} — wait a minute and try again (lower "calls per minute" in Settings).`;
    }
    if (/AddInData|security|permission|clearance/i.test(e.message ?? "")) {
      return `${e.message} — your security clearance needs "View/Administer Add-In Data".`;
    }
    if (e.message) return e.message;
  }
  return String(err);
}

export function fetchSession(api: GeotabApi): Promise<GeotabSession | null> {
  return new Promise((resolve) => {
    if (typeof api.getSession !== "function") {
      resolve(null);
      return;
    }
    let settled = false;
    const done = (s: GeotabSession | null) => {
      if (settled) return;
      settled = true;
      resolve(s);
    };
    setTimeout(() => done(null), 3000);
    try {
      api.getSession((credentials, server) => {
        if (!credentials?.sessionId) {
          done(null);
          return;
        }
        done({
          server: server || "my.geotab.com",
          database: credentials.database,
          userName: credentials.userName,
          sessionId: credentials.sessionId,
        });
      });
    } catch {
      done(null);
    }
  });
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export async function fetchGroups(api: GeotabApi, pacer: Pacer): Promise<Map<string, GeotabGroup>> {
  await pacer.reserve(1);
  const groups = await apiCall<GeotabGroup[]>(api, "Get", { typeName: "Group", resultsLimit: 10000 });
  return new Map(groups.map((g) => [g.id, g]));
}

/** Active devices only (fromDate = now returns devices whose activeTo is in the future). */
export async function fetchActiveDevices(api: GeotabApi, pacer: Pacer): Promise<GeotabDevice[]> {
  await pacer.reserve(1);
  const now = new Date().toISOString();
  let devices: GeotabDevice[];
  try {
    devices = await apiCall<GeotabDevice[]>(api, "Get", {
      typeName: "Device",
      search: { fromDate: now },
      resultsLimit: RESULTS_LIMIT,
      propertySelector: { fields: DEVICE_FIELDS, isIncluded: true },
    });
  } catch {
    await pacer.reserve(1);
    devices = await apiCall<GeotabDevice[]>(api, "Get", {
      typeName: "Device",
      search: { fromDate: now },
      resultsLimit: RESULTS_LIMIT,
    });
  }
  return devices.filter((d) => d.id !== "NoDeviceId");
}

/** Users who can be assigned work: active, not driver-only. */
export async function fetchUsers(api: GeotabApi, pacer: Pacer): Promise<GeotabUser[]> {
  await pacer.reserve(1);
  const users = await apiCall<GeotabUser[]>(api, "Get", { typeName: "User", resultsLimit: 10000 });
  const now = Date.now();
  return users
    .filter((u) => u.id !== "NoUserId" && u.name)
    .filter((u) => !u.activeTo || new Date(u.activeTo).getTime() > now)
    .sort((a, b) => userLabel(a).localeCompare(userLabel(b)));
}

export function userLabel(u: GeotabUser | undefined | null): string {
  if (!u) return "";
  const full = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return full || u.name || u.id;
}

// ---------------------------------------------------------------------------
// Vehicle snapshot: adjusted odometer + engine hours at "now"
// ---------------------------------------------------------------------------

function timeOf(v: string | undefined): number {
  return v ? new Date(v).getTime() : NaN;
}

/**
 * One StatusData call per device and diagnostic with fromDate == toDate == now
 * (MyGeotab returns the records bounding that instant), batched 50 devices
 * per multiCall. Fine for the handful of vehicles a work order / warranty
 * view needs; a fleet-wide sweep goes through `onProgress` and the pacer.
 */
export async function fetchSnapshots(
  api: GeotabApi,
  deviceIds: string[],
  pacer: Pacer,
  onProgress?: (text: string, pct: number | null) => void,
  shouldCancel?: () => boolean
): Promise<Map<string, VehicleSnapshot>> {
  const out = new Map<string, VehicleSnapshot>();
  const ids = Array.from(new Set(deviceIds.filter(Boolean)));
  const at = new Date().toISOString();
  for (let i = 0; i < ids.length; i += SNAPSHOT_BATCH) {
    if (shouldCancel?.()) throw new Error("Cancelled");
    const batch = ids.slice(i, i + SNAPSHOT_BATCH);
    onProgress?.(
      `Reading odometer & engine hours (${Math.min(i + batch.length, ids.length)} / ${ids.length})…`,
      Math.round(((i + batch.length) / ids.length) * 100)
    );
    const calls: Array<[string, unknown]> = [];
    for (const id of batch) {
      for (const diag of [ODOMETER_ADJ, ENGINE_HOURS_ADJ]) {
        calls.push([
          "Get",
          {
            typeName: "StatusData",
            search: { deviceSearch: { id }, diagnosticSearch: { id: diag }, fromDate: at, toDate: at },
            resultsLimit: 10,
          },
        ]);
      }
    }
    await pacer.reserve(calls.length, shouldCancel);
    const results = await apiMultiCall<GeotabStatusData[]>(api, calls);
    batch.forEach((id, idx) => {
      const odoRows = results[idx * 2] ?? [];
      const hrsRows = results[idx * 2 + 1] ?? [];
      const latest = (rows: GeotabStatusData[], diag: string) => {
        let best: GeotabStatusData | null = null;
        for (const r of rows) {
          if (typeof r.data !== "number" || r.dateTime == null) continue;
          if (r.diagnostic?.id && r.diagnostic.id !== diag) continue;
          if (!best || timeOf(r.dateTime) > timeOf(best.dateTime)) best = r;
        }
        return best;
      };
      const o = latest(odoRows, ODOMETER_ADJ);
      const h = latest(hrsRows, ENGINE_HOURS_ADJ);
      out.set(id, {
        deviceId: id,
        odometerMeters: o?.data ?? null,
        odometerAt: o?.dateTime ?? null,
        engineSeconds: h?.data ?? null,
        engineAt: h?.dateTime ?? null,
      });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// DVIR defects awaiting repair
// ---------------------------------------------------------------------------

function defectsOf(log: GeotabDvirLog): GeotabDvirDefect[] {
  const raw = (log.dVIRDefects ?? log.defects ?? []) as GeotabDvirDefect[];
  return Array.isArray(raw) ? raw : [];
}

/**
 * Open DVIR defects in the look-back window for the selected groups: every
 * DVIRDefect with repairStatus NotRepaired (or missing — pre-2019 logs carry
 * no per-defect status, so a log that is not marked repaired counts as open).
 * Defect / part names resolve through the Group tree (defects are groups).
 */
export async function fetchOpenDvirDefects(
  api: GeotabApi,
  pacer: Pacer,
  groupIds: string[],
  lookbackDays: number,
  groupsById: Map<string, GeotabGroup>,
  devicesById: Map<string, GeotabDevice>,
  usersById: Map<string, GeotabUser>
): Promise<DvirDefectItem[]> {
  const to = new Date();
  const from = new Date(to.getTime() - lookbackDays * 86400000);
  const search: Record<string, unknown> = { fromDate: from.toISOString(), toDate: to.toISOString() };
  if (groupIds.length && !groupIds.includes("GroupCompanyId")) {
    search.deviceSearch = { groups: groupIds.map((id) => ({ id })) };
  }
  await pacer.reserve(1);
  const logs = await apiCall<GeotabDvirLog[]>(api, "Get", { typeName: "DVIRLog", search, resultsLimit: 10000 });
  const items: DvirDefectItem[] = [];
  for (const log of logs) {
    const deviceId = log.device?.id;
    if (!deviceId || deviceId === "NoDeviceId") continue;
    const device = devicesById.get(deviceId);
    if (!device) continue; // inactive / out of scope
    for (const d of defectsOf(log)) {
      const status = String(d.repairStatus ?? "").toLowerCase();
      const open = status === "" ? !log.repairDate : status === "notrepaired" || status === "repairdisputed";
      if (!open) continue;
      const defectGroup = d.defect?.id ? groupsById.get(d.defect.id) : undefined;
      const partGroup = d.part?.id ? groupsById.get(d.part.id) : undefined;
      const remarks = (d.defectRemarks ?? [])
        .map((r) => r.remark?.trim())
        .filter((r): r is string => !!r)
        .join(" · ");
      items.push({
        key: `${log.id}:${d.id ?? d.defect?.id ?? "x"}`,
        logId: log.id,
        defectId: d.id ?? d.defect?.id ?? "",
        deviceId,
        deviceName: device.name ?? deviceId,
        dateTime: log.dateTime ?? "",
        driverName: userLabel(log.driver?.id ? usersById.get(log.driver.id) : null),
        defectName: defectGroup?.name ?? d.defect?.name ?? d.defect?.id ?? "Defect",
        partName: partGroup?.name ?? d.part?.name ?? "",
        remarks: remarks || log.driverRemark?.trim() || "",
        isSafeToOperate: typeof log.isSafeToOperate === "boolean" ? log.isSafeToOperate : null,
        repairStatus: d.repairStatus ?? "",
        openWorkOrderNumber: null,
      });
    }
  }
  items.sort((a, b) => b.dateTime.localeCompare(a.dateTime));
  return items;
}

// ---------------------------------------------------------------------------
// Diagnostic names (FaultData only references the diagnostic by id)
// ---------------------------------------------------------------------------

const DIAG_CACHE_KEY = "gpsfms.maintenanceWorkOrders.diagCache.v1";
const DIAG_BATCH = 100;

export interface DiagnosticInfo {
  name: string;
  code: string;
}

function loadDiagCache(): Record<string, DiagnosticInfo> {
  try {
    const raw = window.localStorage.getItem(DIAG_CACHE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, DiagnosticInfo>) : {};
  } catch {
    return {};
  }
}

function saveDiagCache(cache: Record<string, DiagnosticInfo>): void {
  try {
    window.localStorage.setItem(DIAG_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* ignore */
  }
}

export async function resolveDiagnostics(
  api: GeotabApi,
  pacer: Pacer,
  ids: string[]
): Promise<Map<string, DiagnosticInfo>> {
  const cache = loadDiagCache();
  const out = new Map<string, DiagnosticInfo>();
  const todo: string[] = [];
  for (const id of new Set(ids.filter(Boolean))) {
    if (cache[id]) out.set(id, cache[id]);
    else todo.push(id);
  }
  for (let i = 0; i < todo.length; i += DIAG_BATCH) {
    const batch = todo.slice(i, i + DIAG_BATCH);
    await pacer.reserve(batch.length);
    let results: Array<Array<{ id: string; name?: string; code?: number | string }>>;
    try {
      results = await apiMultiCall(
        api,
        batch.map((id) => ["Get", { typeName: "Diagnostic", search: { id }, resultsLimit: 1 }])
      );
    } catch (e) {
      console.warn("[MWO] Diagnostic lookup failed:", e);
      break;
    }
    results.forEach((rows, idx) => {
      const d = Array.isArray(rows) ? rows[0] : undefined;
      if (!d) return;
      const info = { name: d.name ?? batch[idx], code: d.code != null ? String(d.code) : "" };
      out.set(batch[idx], info);
      cache[batch[idx]] = info;
    });
  }
  saveDiagCache(cache);
  return out;
}

// ---------------------------------------------------------------------------
// Active faults
// ---------------------------------------------------------------------------

/**
 * FaultData in the look-back window for the selected groups, reduced to the
 * latest record per device + diagnostic whose state is still Active and that
 * nobody has dismissed. Fleet-wide fault volume can be large, so the window
 * defaults to 7 days and the call is capped at 50k rows.
 */
export async function fetchActiveFaults(
  api: GeotabApi,
  pacer: Pacer,
  groupIds: string[],
  lookbackDays: number,
  devicesById: Map<string, GeotabDevice>,
  deviceId?: string
): Promise<FaultItem[]> {
  const to = new Date();
  const from = new Date(to.getTime() - lookbackDays * 86400000);
  const search: Record<string, unknown> = { fromDate: from.toISOString(), toDate: to.toISOString() };
  if (deviceId) search.deviceSearch = { id: deviceId };
  else if (groupIds.length && !groupIds.includes("GroupCompanyId")) {
    search.deviceSearch = { groups: groupIds.map((id) => ({ id })) };
  }
  await pacer.reserve(1);
  const rows = await apiCall<GeotabFaultData[]>(api, "Get", { typeName: "FaultData", search, resultsLimit: RESULTS_LIMIT });
  const latest = new Map<string, GeotabFaultData>();
  for (const f of rows) {
    const dev = f.device?.id;
    const diag = f.diagnostic?.id;
    if (!dev || !diag) continue;
    const key = `${dev}|${diag}|${f.failureMode?.id ?? ""}`;
    const cur = latest.get(key);
    if (!cur || timeOf(f.dateTime) > timeOf(cur.dateTime)) latest.set(key, f);
  }
  const kept: GeotabFaultData[] = [];
  latest.forEach((f) => {
    const state = String(f.faultState ?? "").toLowerCase();
    const states = (f.faultStates ?? []).map((s) => String(s).toLowerCase());
    const active = state === "active" || states.includes("active") || (state === "" && states.length === 0);
    if (!active || f.dismissDateTime) return;
    if (!devicesById.has(f.device!.id)) return;
    kept.push(f);
  });
  // FaultData carries the diagnostic by id only — resolve names (cached).
  const names = await resolveDiagnostics(
    api,
    pacer,
    kept.map((f) => f.diagnostic!.id)
  );
  const items: FaultItem[] = [];
  kept.forEach((f) => {
    const device = devicesById.get(f.device!.id)!;
    const diag = names.get(f.diagnostic!.id);
    const lamps: string[] = [];
    if (f.redStopLamp) lamps.push("Red stop");
    if (f.amberWarningLamp) lamps.push("Amber");
    if (f.malfunctionLamp) lamps.push("MIL");
    items.push({
      key: f.id,
      faultId: f.id,
      deviceId: device.id,
      deviceName: device.name ?? device.id,
      dateTime: f.dateTime ?? "",
      diagnosticId: f.diagnostic!.id,
      code: diag?.code ?? (f.diagnostic?.code != null ? String(f.diagnostic.code) : ""),
      name: diag?.name ?? f.diagnostic?.name ?? f.diagnostic!.id,
      controller: f.controller?.name ?? "",
      failureMode: f.failureMode?.name ?? "",
      severity: f.severity ?? "",
      count: f.count ?? 1,
      description: f.faultDescription ?? "",
      recommendation: f.recommendation ?? "",
      lamps,
      openWorkOrderNumber: null,
    });
  });
  items.sort((a, b) => b.dateTime.localeCompare(a.dateTime));
  return items;
}
