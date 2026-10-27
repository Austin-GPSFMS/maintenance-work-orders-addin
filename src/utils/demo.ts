/**
 * Deterministic synthetic fleet for the standalone preview (dist/index.html
 * opened outside MyGeotab) and the headless smoke test.
 */

import type {
  DvirDefectItem,
  FaultItem,
  GeotabDevice,
  GeotabGroup,
  GeotabUser,
  ServiceSchedule,
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

  // Service schedules on half the fleet.
  const schedules: ServiceSchedule[] = [];
  for (let i = 0; i < size; i += 2) {
    const d = devices[i];
    const snap = snapshots.get(d.id)!;
    const sinceMeters = rand() * 9000 * MILE;
    schedules.push({
      id: `s-${i}`,
      deviceId: d.id,
      deviceName: d.name!,
      name: i % 4 === 0 ? "Oil & filter change" : i % 4 === 2 ? "DOT annual inspection" : "Hydraulic system service",
      category: i % 4 === 2 ? "inspection" : "preventive",
      intervalMeters: i % 4 === 2 ? null : 7500 * MILE,
      intervalEngineSeconds: i % 4 === 0 ? 250 * 3600 : null,
      intervalDays: i % 4 === 2 ? 365 : 180,
      lastDoneAt: iso(daysAgo(Math.floor(rand() * 400))),
      lastDoneMeters: Math.round(snap.odometerMeters! - sinceMeters),
      lastDoneEngineSeconds: i % 4 === 0 ? snap.engineSeconds! - Math.floor(rand() * 300) * 3600 : null,
      notes: "",
      createdAt: iso(daysAgo(300)),
      updatedAt: iso(daysAgo(300)),
    });
  }

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
    });
  }

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
      openWorkOrderNumber: null,
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
      openWorkOrderNumber: null,
    });
  }

  return { groups, devices, users, snapshots, store: { workOrders, coverages, schedules }, dvir, faults };
}
