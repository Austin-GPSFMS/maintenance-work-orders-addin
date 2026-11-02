/**
 * Deterministic synthetic fleet for the standalone preview (dist/index.html
 * opened outside MyGeotab) and the headless smoke test.
 */

import type {
  DvirDefectItem,
  FaultItem,
  GeotabDevice,
  GeotabGroup,
  GeotabMaintenanceJob,
  GeotabMaintenanceSchedule,
  GeotabMaintenanceWorkOrder,
  GeotabUser,
  StoreData,
  VehicleSnapshot,
  WarrantyCoverage,
  WorkOrder,
} from "../types";
import { addMonths, todayIso } from "./format";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const MILE = 1609.344;
const SITES = ["Dallas", "Fort Worth", "Denton", "Waco"];
const MAKES = ["Peterbilt 520", "Mack LR", "Freightliner M2", "Ford F-250", "Chevrolet Silverado 2500", "Autocar ACX", "Kenworth T880"];

export interface DemoFleet {
  groups: GeotabGroup[];
  devices: GeotabDevice[];
  users: GeotabUser[];
  snapshots: Map<string, VehicleSnapshot>;
  store: StoreData;
  dvir: DvirDefectItem[];
  faults: FaultItem[];
  /** Raw Maintenance Center objects, exactly as MyGeotab would return them. */
  geotabSchedules: GeotabMaintenanceSchedule[];
  geotabWorkOrders: GeotabMaintenanceWorkOrder[];
  geotabJobs: GeotabMaintenanceJob[];
}

export function makeDemoFleet(size = 36, seed = 7, now = new Date()): DemoFleet {
  const rand = rng(seed);
  const groups: GeotabGroup[] = [
    { id: "GroupCompanyId", name: "Company Group", children: SITES.map((_, i) => ({ id: `g-site-${i}` })) },
    ...SITES.map((s, i) => ({ id: `g-site-${i}`, name: s, children: [] })),
  ];
  const users: GeotabUser[] = [
    { id: "u-1", name: "mike.r@demo", firstName: "Mike", lastName: "Reyes" },
    { id: "u-2", name: "sarah.k@demo", firstName: "Sarah", lastName: "Kim" },
    { id: "u-3", name: "dwayne.p@demo", firstName: "Dwayne", lastName: "Patel" },
    { id: "u-4", name: "driver1@demo", firstName: "Luis", lastName: "Ortega", isDriver: true },
  ];
  const devices: GeotabDevice[] = [];
  const snapshots = new Map<string, VehicleSnapshot>();
  for (let i = 0; i < size; i++) {
    const site = i % SITES.length;
    const id = `b${(100 + i).toString(16).toUpperCase()}`;
    const miles = 5000 + Math.floor(rand() * 220000);
    devices.push({
      id,
      name: `${SITES[site].slice(0, 3).toUpperCase()}-${String(101 + i)}`,
      serialNumber: `G9X${(1000000 + i * 7919).toString(36).toUpperCase()}`,
      deviceType: "GO9",
      groups: [{ id: `g-site-${site}` }],
      vehicleIdentificationNumber: `1XP${(1000000000000 + i * 1234567).toString(36).toUpperCase().padEnd(14, "0")}`,
      licensePlate: `TX${(10000 + i * 37) % 99999}`,
    });
    snapshots.set(id, {
      deviceId: id,
      odometerMeters: miles * MILE,
      odometerAt: now.toISOString(),
      engineSeconds: Math.floor(miles / 28) * 3600,
      engineAt: now.toISOString(),
    });
  }

  const iso = (d: Date) => d.toISOString();
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86400000);

  // Warranty coverages on the first dozen vehicles.
  const coverages: WarrantyCoverage[] = [];
  for (let i = 0; i < Math.min(12, size); i++) {
    const d = devices[i];
    const snap = snapshots.get(d.id)!;
    const ageMonths = 6 + Math.floor(rand() * 60);
    const start = addMonths(now, -ageMonths);
    const startMeters = Math.max(0, snap.odometerMeters! - (ageMonths * 1800 + rand() * 20000) * MILE);
    coverages.push({
      id: `c-${i}`,
      deviceId: d.id,
      deviceName: d.name!,
      type: i % 3 === 0 ? "powertrain" : i % 3 === 1 ? "manufacturer" : "extended",
      provider: MAKES[i % MAKES.length].split(" ")[0],
      policyNumber: `W${(48213 + i * 311).toString()}`,
      components: i % 3 === 0 ? "Engine, transmission, axles" : i % 3 === 1 ? "Bumper to bumper" : "Hydraulics + body (Heil)",
      startDate: todayIso(start),
      endDate: null,
      months: i % 3 === 0 ? 60 : i % 3 === 1 ? 36 : 48,
      startMeters: Math.round(startMeters),
      limitMeters: (i % 3 === 0 ? 250000 : i % 3 === 1 ? 36000 : 100000) * MILE,
      startEngineSeconds: null,
      limitEngineSeconds: null,
      notes: "",
      createdAt: iso(daysAgo(200)),
      createdBy: "sarah.k@demo",
      updatedAt: iso(daysAgo(200)),
    });
  }

  // MyGeotab reminder rules (MaintenanceSchedule) — group-scoped like the real thing.
  const mtype = (id: string, name: string, labels: string[]) => ({ id, name, source: "Scheduled", customSource: "Scheduled", sourceType: "Scheduled", createdBy: { id: "u-2" }, labels, activeFrom: iso(daysAgo(400)), activeTo: "9999-12-31T23:59:59.999Z", version: "1" });
  const geotabSchedules: GeotabMaintenanceSchedule[] = [
    { id: "ms-oil", name: "Oil & filter change", active: true, source: "manual", groups: [{ id: "GroupCompanyId" }], labels: ["Oil Change"], kilometers: 12070, months: null, days: null, eventDate: null, eventType: { id: "et-1" }, maintenanceType: mtype("mt-oil", "Oil & filter change", ["Oil Change"]) },
    { id: "ms-dot", name: "DOT annual inspection", active: true, source: "manual", groups: [{ id: "GroupCompanyId" }], labels: ["Inspection"], kilometers: null, months: 12, days: null, eventDate: null, eventType: { id: "et-2" }, maintenanceType: mtype("mt-dot", "DOT annual inspection", ["Inspection"]) },
    { id: "ms-hyd", name: "Hydraulic system service", active: true, source: "manual", groups: [{ id: "g-site-0" }, { id: "g-site-2" }], labels: [], kilometers: 8047, months: 6, days: null, eventDate: null, eventType: { id: "et-3" }, maintenanceType: mtype("mt-hyd", "Hydraulic system service", []) },
    { id: "ms-insight", name: "Oil Life Remaining", active: true, source: "Data Insight", groups: [{ id: "GroupCompanyId" }], labels: ["geotab:oil-change"], kilometers: null, months: null, days: null, eventDate: null, eventType: "EventTypeOilChangeId", maintenanceType: { ...mtype("mt-insight", "Oil Life Remaining", []), sourceType: "DataInsight" } },
  ];

  // Completed Maintenance Center orders + jobs = "last done" per vehicle for those rules.
  const geotabWorkOrders: GeotabMaintenanceWorkOrder[] = [];
  const geotabJobs: GeotabMaintenanceJob[] = [];
  let ref = 100;
  const addGeotab = (deviceIdx: number, scheduleId: string | null, daysBack: number, statusCode: number, notes: string, extra: Partial<GeotabMaintenanceWorkOrder> = {}) => {
    const d = devices[deviceIdx % size];
    const snap = snapshots.get(d.id)!;
    ref += 1;
    const id = `gwo-${ref}`;
    const when = daysAgo(daysBack);
    const odo = Math.max(0, snap.odometerMeters! - daysBack * 55 * MILE);
    geotabWorkOrders.push({
      id,
      reference: String(ref).padStart(6, "0"),
      device: { id: d.id, name: d.name, groups: d.groups },
      dateTime: iso(when),
      updatedDate: iso(when),
      statusCode,
      priorityCode: 100,
      notes,
      odometerReading: Math.round(odo),
      engineHoursReading: "00:00:00",
      engineHoursReadingInHours: Math.round((snap.engineSeconds! - daysBack * 6 * 3600) / 3600),
      completedDateTime: statusCode === 5 ? iso(new Date(when.getTime() + 3600000)) : null,
      costCurrency: "Usd",
      totalCost: 0,
      laborCost: 0,
      partsCost: 0,
      openedByUser: { id: "u-2", name: "sarah.k@demo" },
      version: "1",
      ...extra,
    });
    if (scheduleId) {
      const sch = geotabSchedules.find((x) => x.id === scheduleId)!;
      geotabJobs.push({ id: `job-${ref}`, workOrder: { id }, schedule: { id: scheduleId }, device: { id: d.id }, maintenanceType: sch.maintenanceType, statusCode, severityCode: 100, triggeredDate: iso(when), odometerReading: Math.round(odo), engineHoursReading: "00:00:00" });
    }
    return id;
  };
  for (let i = 0; i < size; i += 2) {
    const back = Math.floor(rand() * 400);
    addGeotab(i, "ms-oil", back, 5, "Oil & filter change\n\nRoutine service.");
    if (i % 4 === 0) addGeotab(i, "ms-dot", 40 + Math.floor(rand() * 500), 5, "DOT annual inspection");
  }
  // Two orders created in Maintenance Center that the add-in has never seen (adoptable), one of them open.
  addGeotab(3, "ms-oil", 2, 1, "Oil & filter change\n\nDue per reminder.", { assignedTo: { id: "u-1", name: "mike.r@demo" }, laborCost: 95, partsCost: 60 });
  addGeotab(9, null, 1, 1, "Replace wiper blades", { assignedTo: { id: "u-3", name: "dwayne.p@demo" } });

  // A handful of work orders in various states.
  const titles = ["Brake chamber leak — LR", "Coolant leak at EGR cooler", "Replace hydraulic hose, packer", "Oil & filter change", "Check engine light — aftertreatment", "Mirror glass replacement", "Tire rotation + alignment"];
  const workOrders: WorkOrder[] = [];
  const statuses: WorkOrder["status"][] = ["open", "in_progress", "on_hold", "completed", "open", "completed", "in_progress", "open"];
  for (let i = 0; i < 8 && i < size; i++) {
    const d = devices[(i * 3) % size];
    const snap = snapshots.get(d.id)!;
    const created = daysAgo(2 + i * 4);
    const status = statuses[i];
    const cov = coverages.find((c) => c.deviceId === d.id);
    const warrantyWork = !!cov && i % 2 === 0;
    const lines = [
      { id: `l-${i}-1`, type: "labor" as const, description: "Diagnose + repair", qty: 2 + (i % 3), unitCost: 95, warranty: warrantyWork },
      { id: `l-${i}-2`, type: "part" as const, description: i % 2 ? "Filter kit" : "Brake chamber, type 30", qty: 1, unitCost: 60 + i * 35, warranty: warrantyWork },
    ];
    workOrders.push({
      id: `w-${i}`,
      number: i + 1,
      deviceId: d.id,
      deviceName: d.name!,
      title: titles[i % titles.length],
      description: i % 2 ? "Driver reported on pre-trip." : "Found on PM inspection.",
      status,
      priority: (["high", "medium", "critical", "low"] as const)[i % 4],
      category: (["repair", "preventive", "repair", "tires"] as const)[i % 4],
      assigneeId: i % 3 === 2 ? null : users[i % 3].id,
      assigneeName: i % 3 === 2 ? "" : `${users[i % 3].firstName} ${users[i % 3].lastName}`,
      vendor: i % 4 === 3 ? "Southern Tire Mart" : "",
      invoiceNumber: status === "completed" ? `INV-${7700 + i}` : "",
      createdAt: iso(created),
      createdBy: "sarah.k@demo",
      updatedAt: iso(created),
      updatedBy: "sarah.k@demo",
      dueDate: i === 0 ? todayIso(daysAgo(3)) : i === 4 ? todayIso(daysAgo(-5)) : null,
      startedAt: status === "in_progress" || status === "completed" ? iso(daysAgo(1 + i * 3)) : null,
      completedAt: status === "completed" ? iso(daysAgo(i)) : null,
      odometerAtOpen: snap.odometerMeters! - 400 * MILE,
      engineSecondsAtOpen: snap.engineSeconds! - 20 * 3600,
      odometerAtClose: status === "completed" ? snap.odometerMeters : null,
      engineSecondsAtClose: status === "completed" ? snap.engineSeconds : null,
      source: i % 3 === 0 ? { type: "dvir", refId: `dvir-${i}`, defectId: `def-${i}`, label: "DVIR — Brakes: air leak" } : i % 3 === 1 ? { type: "fault", refId: `f-${i}`, diagnosticId: "diag-x", label: "Fault SPN 3251 FMI 0" } : { type: "manual", label: "Manual entry" },
      lines,
      warranty: {
        eligible: !!cov,
        coverageId: cov?.id ?? null,
        coverageLabel: cov ? `${cov.type} · ${cov.provider} · #${cov.policyNumber}` : "",
        isWarrantyWork: warrantyWork,
        claim: warrantyWork
          ? { status: status === "completed" ? "submitted" : "pending", claimNumber: status === "completed" ? `CLM-${1200 + i}` : "", submittedAt: status === "completed" ? iso(daysAgo(i)) : null, resolvedAt: null, amountClaimed: status === "completed" ? 350 + i * 40 : null, amountRecovered: null, notes: "" }
          : { status: "none", claimNumber: "", submittedAt: null, resolvedAt: null, amountClaimed: null, amountRecovered: null, notes: "" },
      },
      activity: [{ at: iso(created), by: "sarah.k@demo", text: "Created" }],
      geotab: null,
    });
  }
  // Link every other add-in order to a Maintenance Center header (the merged list reads status from it).
  workOrders.forEach((w, i) => {
    if (i % 2) return;
    const code = w.status === "completed" ? 5 : 1;
    const id = addGeotab((i * 3) % size, w.source.type === "schedule" ? "ms-oil" : null, 2 + i * 4, code, `${w.title}\n\n${w.description}`, { assignedTo: w.assigneeId ? { id: w.assigneeId, name: w.assigneeName } : null });
    const g = geotabWorkOrders.find((x) => x.id === id)!;
    w.geotab = { id, reference: g.reference!, statusCode: code, jobId: null };
  });

  // Open DVIR defects and active faults to convert.
  const dvir: DvirDefectItem[] = [];
  const defects = [["Brakes", "Air pressure drop"], ["Lights", "Left tail lamp out"], ["Tires", "Cut in sidewall RR"], ["Hydraulics", "Packer slow to cycle"], ["Mirrors", "Cracked convex mirror"]];
  for (let i = 0; i < 6 && i < size; i++) {
    const d = devices[(i * 5 + 1) % size];
    const [defectName, remark] = defects[i % defects.length];
    dvir.push({
      key: `dv-${i}`,
      logId: `dvirlog-${i}`,
      defectId: `dvirdef-${i}`,
      deviceId: d.id,
      deviceName: d.name!,
      dateTime: iso(daysAgo(rand() * 6)),
      driverName: "Luis Ortega",
      defectName,
      partName: i % 2 ? "Rear" : "",
      remarks: remark,
      isSafeToOperate: i % 3 !== 0,
      repairStatus: "NotRepaired",
      openWorkOrderKey: null,
    });
  }
  const faults: FaultItem[] = [];
  const codes = [["SPN 3251 FMI 0", "DPF differential pressure — high", "Red stop"], ["SPN 111 FMI 1", "Coolant level — low", "Amber"], ["P0420", "Catalyst efficiency below threshold (bank 1)", "MIL"], ["SPN 102 FMI 2", "Intake manifold pressure — data erratic", ""]];
  for (let i = 0; i < 5 && i < size; i++) {
    const d = devices[(i * 7 + 2) % size];
    const [code, name, lamp] = codes[i % codes.length];
    faults.push({
      key: `fl-${i}`,
      faultId: `fault-${i}`,
      deviceId: d.id,
      deviceName: d.name!,
      dateTime: iso(daysAgo(rand() * 3)),
      diagnosticId: `diag-${i}`,
      code: code.split(" ")[1] ?? code,
      name: `${code} ${name}`,
      controller: "Engine #1",
      failureMode: "",
      severity: lamp === "Red stop" ? "High" : "Medium",
      count: 1 + Math.floor(rand() * 20),
      description: name,
      recommendation: lamp === "Red stop" ? "Stop vehicle safely, service immediately." : "Service at next opportunity.",
      lamps: lamp ? [lamp] : [],
      openWorkOrderKey: null,
    });
  }

  return { groups, devices, users, snapshots, store: { workOrders, coverages, schedules: [] }, dvir, faults, geotabSchedules, geotabWorkOrders, geotabJobs };
}
