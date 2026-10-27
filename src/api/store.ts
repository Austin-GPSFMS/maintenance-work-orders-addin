/**
 * Persistence for work orders, warranty coverages and service schedules.
 *
 * Inside MyGeotab everything is stored as AddInData records under one fixed
 * `addInId` (so a single `Get AddInData { addInId }` loads the whole dataset
 * and MyGeotab's security clearance for Add-In Data governs access):
 *
 *   details = { kind: "wo" | "coverage" | "schedule", v: 1, data: {...} }
 *
 * Each record's `groups` are the vehicle's groups at save time (falling back
 * to the whole organization), so a user scoped to a site sees the work orders
 * for the vehicles they can see.
 *
 * The standalone preview (dist/index.html opened outside MyGeotab) and the
 * smoke test use the in-memory store instead.
 */

import type { GeotabAddInData, GeotabApi, GeotabDevice, ServiceSchedule, StoreData, WarrantyCoverage, WorkOrder } from "../types";
import { apiCall, Pacer } from "./geotab";

/**
 * Fixed add-in id for this add-in's AddInData records — an encoded GUID in the
 * Geotab "a" + base64url format. Changing it orphans every existing record.
 */
export const ADDIN_DATA_ID = "asygz9FPN25G-GS0AyIqrkA";
export const SCHEMA_VERSION = 1;
/** MyGeotab rejects oversized details; keep well under its limit. */
export const DETAILS_SOFT_LIMIT = 9000;

type Kind = "wo" | "coverage" | "schedule";

interface Envelope<T> {
  kind: Kind;
  v: number;
  data: T;
}

export interface Store {
  readonly label: string;
  load(): Promise<StoreData>;
  saveWorkOrder(wo: WorkOrder): Promise<WorkOrder>;
  deleteWorkOrder(id: string): Promise<void>;
  saveCoverage(c: WarrantyCoverage): Promise<WarrantyCoverage>;
  deleteCoverage(id: string): Promise<void>;
  saveSchedule(s: ServiceSchedule): Promise<ServiceSchedule>;
  deleteSchedule(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// AddInData-backed store
// ---------------------------------------------------------------------------

export class AddInDataStore implements Store {
  readonly label = "MyGeotab Add-In Data";
  constructor(
    private api: GeotabApi,
    private pacer: Pacer,
    private devicesById: () => Map<string, GeotabDevice>
  ) {}

  private groupsFor(deviceId: string): Array<{ id: string }> {
    const d = this.devicesById().get(deviceId);
    const g = (d?.groups ?? []).filter((x) => x && x.id);
    return g.length ? g.map((x) => ({ id: x.id })) : [{ id: "GroupCompanyId" }];
  }

  async load(): Promise<StoreData> {
    await this.pacer.reserve(1);
    const rows = await apiCall<GeotabAddInData[]>(this.api, "Get", {
      typeName: "AddInData",
      search: { addInId: ADDIN_DATA_ID },
      resultsLimit: 50000,
    });
    const out: StoreData = { workOrders: [], coverages: [], schedules: [] };
    for (const r of rows) {
      const env = parseEnvelope(r.details);
      if (!env || !r.id) continue;
      const data = { ...(env.data as object), id: r.id };
      if (env.kind === "wo") out.workOrders.push(migrateWorkOrder(data as WorkOrder));
      else if (env.kind === "coverage") out.coverages.push(data as WarrantyCoverage);
      else if (env.kind === "schedule") out.schedules.push(data as ServiceSchedule);
    }
    out.workOrders.sort((a, b) => b.number - a.number);
    return out;
  }

  private async save<T extends { id?: string; deviceId: string }>(kind: Kind, item: T): Promise<T> {
    const { id, ...data } = item;
    const details: Envelope<Omit<T, "id">> = { kind, v: SCHEMA_VERSION, data };
    const json = JSON.stringify(details);
    if (json.length > DETAILS_SOFT_LIMIT) {
      throw new Error(
        `This record is ${json.length.toLocaleString()} characters — over the ${DETAILS_SOFT_LIMIT.toLocaleString()} limit MyGeotab allows per Add-In Data record. Trim the notes/activity and try again.`
      );
    }
    const entity: GeotabAddInData = { addInId: ADDIN_DATA_ID, details, groups: this.groupsFor(item.deviceId) };
    await this.pacer.reserve(1);
    if (id) {
      await apiCall(this.api, "Set", { typeName: "AddInData", entity: { ...entity, id } });
      return item;
    }
    const newId = await apiCall<string>(this.api, "Add", { typeName: "AddInData", entity });
    return { ...item, id: newId };
  }

  private async remove(id: string): Promise<void> {
    await this.pacer.reserve(1);
    await apiCall(this.api, "Remove", { typeName: "AddInData", entity: { id, addInId: ADDIN_DATA_ID } });
  }

  saveWorkOrder(wo: WorkOrder) {
    return this.save("wo", wo);
  }
  deleteWorkOrder(id: string) {
    return this.remove(id);
  }
  saveCoverage(c: WarrantyCoverage) {
    return this.save("coverage", c);
  }
  deleteCoverage(id: string) {
    return this.remove(id);
  }
  saveSchedule(s: ServiceSchedule) {
    return this.save("schedule", s);
  }
  deleteSchedule(id: string) {
    return this.remove(id);
  }
}

function parseEnvelope(details: unknown): Envelope<unknown> | null {
  let d = details;
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      return null;
    }
  }
  if (!d || typeof d !== "object") return null;
  const e = d as Partial<Envelope<unknown>>;
  if (e.kind !== "wo" && e.kind !== "coverage" && e.kind !== "schedule") return null;
  if (!e.data || typeof e.data !== "object") return null;
  return { kind: e.kind, v: typeof e.v === "number" ? e.v : 1, data: e.data };
}

/** Fill anything a future schema adds so older records still render. */
export function migrateWorkOrder(wo: WorkOrder): WorkOrder {
  return {
    ...wo,
    lines: Array.isArray(wo.lines) ? wo.lines : [],
    activity: Array.isArray(wo.activity) ? wo.activity : [],
    warranty: wo.warranty ?? {
      eligible: false,
      coverageId: null,
      coverageLabel: "",
      isWarrantyWork: false,
      claim: { status: "none", claimNumber: "", submittedAt: null, resolvedAt: null, amountClaimed: null, amountRecovered: null, notes: "" },
    },
    source: wo.source ?? { type: "manual", label: "Manual" },
  };
}

// ---------------------------------------------------------------------------
// In-memory store (standalone preview / smoke test)
// ---------------------------------------------------------------------------

export class MemoryStore implements Store {
  readonly label = "demo (in-memory)";
  private seq = 0;
  constructor(private data: StoreData) {
    for (const list of [data.workOrders, data.coverages, data.schedules] as Array<Array<{ id?: string }>>) {
      for (const item of list) if (!item.id) item.id = this.nextId();
    }
  }
  private nextId() {
    this.seq += 1;
    return `mem-${this.seq}`;
  }
  private async delay() {
    await new Promise((r) => setTimeout(r, 120));
  }
  async load(): Promise<StoreData> {
    await this.delay();
    return {
      workOrders: this.data.workOrders.map((w) => ({ ...w })).sort((a, b) => b.number - a.number),
      coverages: this.data.coverages.map((c) => ({ ...c })),
      schedules: this.data.schedules.map((s) => ({ ...s })),
    };
  }
  private upsert<T extends { id?: string }>(list: T[], item: T): T {
    const saved = { ...item, id: item.id ?? this.nextId() };
    const idx = list.findIndex((x) => x.id === saved.id);
    if (idx >= 0) list[idx] = saved;
    else list.push(saved);
    return saved;
  }
  async saveWorkOrder(wo: WorkOrder) {
    await this.delay();
    return this.upsert(this.data.workOrders, wo);
  }
  async deleteWorkOrder(id: string) {
    await this.delay();
    this.data.workOrders = this.data.workOrders.filter((w) => w.id !== id);
  }
  async saveCoverage(c: WarrantyCoverage) {
    await this.delay();
    return this.upsert(this.data.coverages, c);
  }
  async deleteCoverage(id: string) {
    await this.delay();
    this.data.coverages = this.data.coverages.filter((c) => c.id !== id);
  }
  async saveSchedule(s: ServiceSchedule) {
    await this.delay();
    return this.upsert(this.data.schedules, s);
  }
  async deleteSchedule(id: string) {
    await this.delay();
    this.data.schedules = this.data.schedules.filter((s) => s.id !== id);
  }
}
