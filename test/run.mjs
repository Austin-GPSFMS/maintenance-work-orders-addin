/**
 * Offline checks for the pure maths: warranty evaluation, service-schedule
 * due state, work-order factories / transitions / totals, CSV.
 *   npm test
 */
import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = resolve(here, ".build/rules.mjs");
await build({ entryPoints: [resolve(here, "rules-entry.ts")], bundle: true, format: "esm", platform: "node", outfile: bundle, logLevel: "silent" });
const m = await import(pathToFileURL(bundle).href);

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`✓ ${name}`);
  } else {
    failed += 1;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const MILE = 1609.344;
const now = new Date("2026-10-27T12:00:00");
const settings = { units: "mi", currency: "USD", expiringDays: 60, expiringMeters: 5000 * MILE, dueSoonFraction: 0.9, dvirLookbackDays: 30, faultLookbackDays: 7, callsPerMinute: 600, laborRate: 95 };
const snap = (mi, h) => ({ deviceId: "d1", odometerMeters: mi * MILE, odometerAt: now.toISOString(), engineSeconds: h == null ? null : h * 3600, engineAt: now.toISOString() });
const cov = (over) => ({ id: "c1", deviceId: "d1", deviceName: "T-1", type: "powertrain", provider: "X", policyNumber: "", components: "", startDate: "2024-01-15", endDate: null, months: 36, startMeters: 1000 * MILE, limitMeters: 100000 * MILE, startEngineSeconds: null, limitEngineSeconds: null, notes: "", createdAt: "", createdBy: "", updatedAt: "", ...over });

// ---- Warranty coverage ----
{
  const ev = m.evaluateCoverage(cov(), snap(50000), settings, now);
  check("coverage active when inside date + distance", ev.state === "active", JSON.stringify(ev));
  check("distance left = start + limit − odometer", Math.round(ev.metersLeft / MILE) === 51000, String(ev.metersLeft / MILE));
  check("end date = start + months", ev.endsOn?.startsWith("2027-01-15"), ev.endsOn);
}
{
  const ev = m.evaluateCoverage(cov(), snap(99000), settings, now);
  check("coverage expiring inside the distance threshold", ev.state === "expiring", ev.state);
}
{
  const ev = m.evaluateCoverage(cov(), snap(102000), settings, now);
  check("coverage expired once distance limit is passed", ev.state === "expired", ev.state);
}
{
  const ev = m.evaluateCoverage(cov({ months: 24 }), snap(20000), settings, now);
  check("coverage expired once the term has passed", ev.state === "expired", ev.state);
}
{
  const ev = m.evaluateCoverage(cov({ endDate: "2026-12-01" }), snap(20000), settings, now);
  check("explicit end date overrides months and triggers expiring within 60 days", ev.state === "expiring" && ev.daysLeft === 35, JSON.stringify(ev));
}
{
  const ev = m.evaluateCoverage(cov(), undefined, settings, now);
  check("no odometer reading → date still evaluated, distance noted as unchecked", ev.state === "active" && ev.reasons.some((r) => /not checked/.test(r)), JSON.stringify(ev));
}
{
  const ev = m.evaluateCoverage(cov({ months: null, limitMeters: null }), undefined, settings, now);
  check("coverage with no end and no limits is open-ended active", ev.state === "active", ev.state);
}
{
  const ev = m.evaluateCoverage(cov({ startDate: "2027-03-01" }), snap(1000), settings, now);
  check("future start date → not started", ev.state === "not_started", ev.state);
}
{
  const ev = m.evaluateCoverage(cov({ limitMeters: null, startEngineSeconds: 100 * 3600, limitEngineSeconds: 2000 * 3600 }), snap(5000, 2150), settings, now);
  check("engine-hours limit expires coverage", ev.state === "expired" && ev.engineSecondsLeft < 0, JSON.stringify(ev));
}
{
  const active = m.activeCoverages("d1", [cov(), cov({ id: "c2", months: 12 })], snap(50000), settings, now);
  check("activeCoverages drops expired ones", active.length === 1 && active[0].coverage.id === "c1", String(active.length));
}

// ---- Service schedules ----
const sched = (over) => ({ id: "s1", deviceId: "d1", deviceName: "T-1", name: "Oil", category: "preventive", intervalMeters: 7500 * MILE, intervalEngineSeconds: null, intervalDays: 180, lastDoneAt: "2026-06-01", lastDoneMeters: 40000 * MILE, lastDoneEngineSeconds: null, notes: "", createdAt: "", updatedAt: "", ...over });
{
  const ev = m.evaluateSchedule(sched(), snap(43000), [], settings, now);
  check("schedule ok at 40% distance / 82% days", ev.state === "ok" && ev.progress > 0.8 && ev.progress < 0.9, JSON.stringify(ev));
}
{
  const ev = m.evaluateSchedule(sched(), snap(46900), [], settings, now);
  check("schedule due soon in the last 10% of the distance interval", ev.state === "due_soon", JSON.stringify(ev));
}
{
  const ev = m.evaluateSchedule(sched(), snap(48000), [], settings, now);
  check("schedule overdue past the distance interval", ev.state === "overdue" && ev.reasons.some((r) => /overdue/.test(r)), JSON.stringify(ev));
}
{
  const ev = m.evaluateSchedule(sched({ lastDoneAt: "2026-01-01" }), snap(41000), [], settings, now);
  check("schedule overdue on days alone", ev.state === "overdue", JSON.stringify(ev));
}
{
  const ev = m.evaluateSchedule(sched(), undefined, [], settings, now);
  check("no odometer → days still evaluated", ev.state === "ok" && ev.reasons.some((r) => /No current odometer/.test(r)), JSON.stringify(ev));
}
{
  const open = { number: 7, status: "open", source: { type: "schedule", refId: "s1", label: "" } };
  const ev = m.evaluateSchedule(sched(), snap(48000), [open], settings, now);
  check("schedule reports its open work order", ev.openWorkOrderNumber === 7, String(ev.openWorkOrderNumber));
}

// ---- Work orders ----
const base = { deviceId: "d1", deviceName: "T-1", by: "me", existing: [{ number: 41 }, { number: 12 }], coverages: [cov()], snapshot: snap(50000, 1200), settings, now };
const wo = m.createWorkOrder(base);
check("new work order gets the next number", wo.number === 42, String(wo.number));
check("new work order captures odometer + hours at open", wo.odometerAtOpen === 50000 * MILE && wo.engineSecondsAtOpen === 1200 * 3600);
check("new work order is warranty-eligible with an active coverage and defaults to warranty work", wo.warranty.eligible && wo.warranty.isWarrantyWork && wo.warranty.coverageId === "c1", JSON.stringify(wo.warranty));
const woNoCov = m.createWorkOrder({ ...base, coverages: [] });
check("no coverage → not eligible, not warranty work", !woNoCov.warranty.eligible && !woNoCov.warranty.isWarrantyWork);
check("formatNumber pads", m.formatNumber(42) === "WO-00042", m.formatNumber(42));

const dv = m.fromDvirDefect(wo, { key: "k", logId: "L1", defectId: "D1", deviceId: "d1", deviceName: "T-1", dateTime: "2026-10-20T10:00:00Z", driverName: "Lu", defectName: "Brakes", partName: "Rear", remarks: "soft pedal", isSafeToOperate: false, repairStatus: "NotRepaired", openWorkOrderNumber: null });
check("DVIR conversion: title, critical when unsafe, source refs", dv.title === "Brakes — Rear" && dv.priority === "critical" && dv.source.type === "dvir" && dv.source.defectId === "D1" && dv.source.refId === "L1", JSON.stringify(dv.source));
const ft = m.fromFault(wo, { key: "k", faultId: "F1", deviceId: "d1", deviceName: "T-1", dateTime: "2026-10-20T10:00:00Z", diagnosticId: "G1", code: "3251", name: "DPF pressure", controller: "", failureMode: "", severity: "", count: 3, description: "", recommendation: "", lamps: ["Red stop"], openWorkOrderNumber: null });
check("fault conversion: red stop lamp → critical, diagnostic kept", ft.priority === "critical" && ft.source.diagnosticId === "G1" && /3251/.test(ft.title), JSON.stringify(ft.source));

let t = m.transition(wo, "in_progress", "me", snap(50010, 1201), now);
check("start work sets startedAt", t.status === "in_progress" && t.startedAt != null && t.activity.length === 2);
t = m.transition(t, "completed", "me", snap(50010, 1201), now);
check("complete captures odometer/hours at close", t.completedAt != null && t.odometerAtClose === 50010 * MILE && t.engineSecondsAtClose === 1201 * 3600);
const rolled = m.rollSchedule(sched(), t, now);
check("completing a scheduled job rolls last-done forward", rolled.lastDoneMeters === 50010 * MILE && rolled.lastDoneEngineSeconds === 1201 * 3600 && rolled.lastDoneAt === t.completedAt);
const reopened = m.transition(t, "open", "me", undefined, now);
check("reopen clears completedAt", reopened.completedAt === null && reopened.status === "open");

const lined = { ...wo, lines: [{ id: "a", type: "labor", description: "x", qty: 2, unitCost: 95, warranty: true }, { id: "b", type: "part", description: "y", qty: 3, unitCost: 10, warranty: false }] };
const tot = m.totals(lined);
check("totals split warranty vs fleet", tot.total === 220 && tot.warranty === 190 && tot.fleet === 30, JSON.stringify(tot));
check("overdue when due date passed and active", m.isOverdue({ ...wo, dueDate: "2026-10-20" }, now) && !m.isOverdue({ ...wo, dueDate: "2026-10-20", status: "completed" }, now));
check("overdue not triggered on the due date itself", !m.isOverdue({ ...wo, dueDate: "2026-10-27" }, now));
check("search matches number and vehicle", m.matchesSearch(lined, "wo-00042 t-1") && !m.matchesSearch(lined, "zzz"));
check("view filter: claims", m.matchesView({ ...wo, warranty: { ...wo.warranty, claim: { ...wo.warranty.claim, status: "submitted" } } }, "claims", now) && !m.matchesView(wo, "claims", now));
const csv = m.workOrdersCsv([lined], settings);
check("CSV has header + row and quotes the title", csv.split("\n").length === 2 && csv.includes("WO-00042"), csv.slice(0, 120));

// ---- Demo fleet sanity ----
const fleet = m.makeDemoFleet(36, 7, now);
check("demo fleet is deterministic", fleet.devices[3].name === m.makeDemoFleet(36, 7, now).devices[3].name);
check("demo fleet has orders, coverages, schedules, intake", fleet.store.workOrders.length === 8 && fleet.store.coverages.length === 12 && fleet.store.schedules.length === 18 && fleet.dvir.length === 6 && fleet.faults.length === 5);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
