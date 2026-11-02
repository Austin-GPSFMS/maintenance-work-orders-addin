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
const reopened = m.transition(t, "open", "me", undefined, now);
check("reopen clears completedAt", reopened.completedAt === null && reopened.status === "open");

const lined = { ...wo, lines: [{ id: "a", type: "labor", description: "x", qty: 2, unitCost: 95, warranty: true }, { id: "b", type: "part", description: "y", qty: 3, unitCost: 10, warranty: false }] };
const tot = m.totals(lined);
check("totals split warranty vs fleet", tot.total === 220 && tot.warranty === 190 && tot.fleet === 30, JSON.stringify(tot));
check("overdue when due date passed and active", m.isOverdue({ ...wo, dueDate: "2026-10-20" }, now) && !m.isOverdue({ ...wo, dueDate: "2026-10-20", status: "completed" }, now));
check("overdue not triggered on the due date itself", !m.isOverdue({ ...wo, dueDate: "2026-10-27" }, now));
check("search matches number and vehicle", m.matchesSearch(lined, "wo-00042 t-1") && !m.matchesSearch(lined, "zzz"));
check("formatNumber prefers the Geotab reference", m.formatNumber({ ...wo, geotab: { id: "g1", reference: "000161", statusCode: 1, jobId: null } }) === "#000161" && m.formatNumber(wo) === "WO-00042");
check("view filter: claims", m.matchesView({ ...wo, warranty: { ...wo.warranty, claim: { ...wo.warranty.claim, status: "submitted" } } }, "claims", now) && !m.matchesView(woNoCov, "claims", now) && m.matchesView(wo, "claims", now) /* eligible → claim defaults to "to be filed" */);
const csv = m.workOrdersCsv([lined], settings);
check("CSV has header + row and quotes the title", csv.split("\n").length === 2 && csv.includes("WO-00042"), csv.slice(0, 120));

// ---- Demo fleet sanity ----
const fleet = m.makeDemoFleet(36, 7, now);
check("demo fleet is deterministic", fleet.devices[3].name === m.makeDemoFleet(36, 7, now).devices[3].name);
check("demo fleet has orders, coverages, Maintenance Center objects, intake", fleet.store.workOrders.length === 8 && fleet.store.coverages.length === 12 && fleet.geotabSchedules.length === 4 && fleet.geotabWorkOrders.length > 20 && fleet.geotabJobs.length > 10 && fleet.dvir.length === 6 && fleet.faults.length === 5);


// ---- Maintenance Center: normalizers ----
const S2 = { ...m.DEFAULT_SETTINGS, units: "mi" };
check("timeSpan round-trip", m.timeSpanToSeconds("1.05:03:36") === 104616 && m.secondsToTimeSpan(104616) === "1.05:03:36" && m.secondsToTimeSpan(3600) === "01:00:00" && m.timeSpanToSeconds("") === null);
const rawSched = { id: "bBC", name: "Oil Change", active: true, source: "manual", groups: [{ id: "GroupCompanyId" }], labels: ["app:oil change"], kilometers: 8045, months: null, days: null, eventDate: null, eventType: "EventTypeOilChangeId", maintenanceType: { id: "bD1", name: "Oil Change", source: "Scheduled", customSource: "Scheduled", sourceType: "Scheduled", createdBy: "NoUserId", labels: ["app:oil change"] } };
const rule = m.normalizeSchedule(rawSched);
check("normalizeSchedule: km → metres, groups, maintenanceType", rule.intervalMeters === 8045000 && rule.groupIds[0] === "GroupCompanyId" && rule.maintenanceTypeId === "bD1" && rule.intervalMonths === null, JSON.stringify(rule));
check("Data Insight rules are not user reminders", !m.isUserReminder(m.normalizeSchedule({ ...rawSched, id: "x", source: "Data Insight" })) && m.isUserReminder(rule));
const rawJob = { id: "j1", workOrder: { id: "w1" }, schedule: { id: "bBC" }, device: { id: "d1" }, maintenanceType: rawSched.maintenanceType, statusCode: 5, severityCode: 100, triggeredDate: "2026-06-01T00:00:00Z", odometerReading: 80000000, engineHoursReading: "00:00:00" };
const job = m.normalizeJob(rawJob);
check("normalizeJob: links + zero hours → null", job.scheduleId === "bBC" && job.workOrderId === "w1" && job.odometerMeters === 80000000 && job.engineSeconds === null);
check("notes compose/split round-trip", (() => { const n = m.composeNotes({ ...wo, title: "Brake job", description: "LR chamber", vendor: "", invoiceNumber: "" }); const r = m.splitNotes(n); return r.title === "Brake job" && r.description === "LR chamber"; })());

// ---- Maintenance Center: status mapping + merge ----
check("statusFromCode keeps a local active status that maps to the same code", m.statusFromCode(1, "in_progress", S2.statusCodeMap) === "in_progress" && m.statusFromCode(5, "in_progress", S2.statusCodeMap) === "completed" && m.statusFromCode(1, null, S2.statusCodeMap) === "open" && m.statusFromCode(1, "completed", S2.statusCodeMap) === "open");
check("priorityFromCode prefers medium for Geotab's default code", m.priorityFromCode(100, null, S2.priorityCodeMap) === "medium" && m.priorityFromCode(100, "high", S2.priorityCodeMap) === "high");
const devices = new Map([["d1", { id: "d1", name: "T-1", groups: [{ id: "GroupCompanyId" }] }], ["d2", { id: "d2", name: "T-2", groups: [{ id: "GroupCompanyId" }] }]]);
const usersMap = new Map([["u1", { id: "u1", name: "mike@x", firstName: "Mike", lastName: "R" }]]);
const g1 = { id: "g1", reference: "000010", device: { id: "d1", name: "T-1" }, dateTime: "2026-10-01T10:00:00Z", updatedDate: "2026-10-02T10:00:00Z", statusCode: 5, priorityCode: 100, notes: "Brake job\n\nLR chamber", completedDateTime: "2026-10-02T10:00:00Z", assignedTo: { id: "u1" }, odometerReading: 1000, engineHoursReading: "00:00:00", laborCost: 95, partsCost: 60 };
const g2 = { id: "g2", reference: "000011", device: { id: "d2" }, dateTime: "2026-10-03T10:00:00Z", statusCode: 1, priorityCode: 100, notes: "Oil change", odometerReading: 0 };
const localLinked = { ...wo, id: "a1", deviceId: "d1", status: "in_progress", assigneeId: null, assigneeName: "", lines: [{ id: "l", type: "labor", description: "x", qty: 1, unitCost: 1, warranty: true }], geotab: { id: "g1", reference: "000010", statusCode: 1, jobId: null } };
const localUnsynced = { ...wo, id: "a2", deviceId: "d2", number: 43, geotab: null };
const localOrphan = { ...wo, id: "a3", deviceId: "d2", number: 44, geotab: { id: "gone", reference: "000001", statusCode: 1, jobId: null } };
const jobs = [m.normalizeJob({ ...rawJob, workOrder: { id: "g2" }, device: { id: "d2" }, statusCode: 1 })];
const merged = m.mergeWorkOrders({ local: [localLinked, localUnsynced, localOrphan], geotab: [g1, g2], jobs, rules: [rule], devicesById: devices, usersById: usersMap, settings: S2 });
const mg1 = merged.workOrders.find((w) => w.geotab?.id === "g1");
const mg2 = merged.workOrders.find((w) => w.geotab?.id === "g2");
check("merge: linked order takes status/assignee/completedAt from Geotab, keeps add-in lines", mg1.status === "completed" && mg1.completedAt === "2026-10-02T10:00:00Z" && mg1.assigneeName === "Mike R" && mg1.lines.length === 1 && mg1.lines[0].warranty === true, JSON.stringify({ s: mg1.status, a: mg1.assigneeName, l: mg1.lines.length }));
check("merge: Geotab-only order synthesized with title from notes, source from its job, cost lines", mg2 && mg2.id === undefined && mg2.title === "Oil change" && mg2.source.type === "schedule" && mg2.source.refId === "bBC" && mg2.status === "open" && mg2.geotab.reference === "000011", JSON.stringify(mg2 && { t: mg2.title, s: mg2.source, st: mg2.status }));
check("merge: unsynced local order kept; orphan reported", merged.workOrders.some((w) => w.id === "a2") && merged.orphaned.length === 1 && merged.orphaned[0].id === "a3");
check("woKey stable across the split", m.woKey(mg1) === "g1" && m.woKey(localUnsynced) === "a2");

// ---- Reminders: rule × vehicle ----
const expand = (ids) => new Set(ids);
const snaps = new Map([["d1", { deviceId: "d1", odometerMeters: 90000000, odometerAt: now.toISOString(), engineSeconds: null, engineAt: null }], ["d2", { deviceId: "d2", odometerMeters: 83000000, odometerAt: now.toISOString(), engineSeconds: null, engineAt: null }]]);
const doneJob = m.normalizeJob({ ...rawJob, id: "j-done", workOrder: { id: "g1" }, device: { id: "d1" }, statusCode: 5, odometerReading: 80000000 });
const openJob = m.normalizeJob({ ...rawJob, id: "j-open", workOrder: { id: "g2" }, device: { id: "d2" }, statusCode: 1, odometerReading: 0 });
const rrows = m.buildReminderRows({ rules: [rule], devices: [devices.get("d1"), devices.get("d2")], expand, jobs: [doneJob, openJob], geotabById: new Map([["g1", g1], ["g2", g2]]), snapshots: snaps, settings: S2, now });
const r1 = rrows.find((r) => r.deviceId === "d1");
const r2 = rrows.find((r) => r.deviceId === "d2");
check("reminder: last done from the completed job → 10,000 km used of 8,045 → overdue", r1.lastDone?.odometerMeters === 80000000 && r1.evaluation.state === "overdue", JSON.stringify(r1.evaluation));
check("reminder: vehicle with only an open job → unknown + open order id", r2.evaluation.state === "unknown" && r2.openWorkOrderId === "g2" && r2.lastDone === null, JSON.stringify({ e: r2.evaluation.state, o: r2.openWorkOrderId }));
check("reminder: rule scoped to a group only covers its vehicles", m.buildReminderRows({ rules: [{ ...rule, groupIds: ["g-x"] }], devices: [devices.get("d1")], expand, jobs: [], geotabById: new Map(), snapshots: snaps, settings: S2, now }).length === 0);
const oneOff = m.buildReminderRows({ rules: [{ ...rule, intervalMeters: null, eventDate: "2026-10-01" }], devices: [devices.get("d2")], expand, jobs: [], geotabById: new Map(), snapshots: snaps, settings: S2, now })[0];
check("reminder: one-off event date in the past with nothing done → overdue", oneOff.evaluation.state === "overdue", JSON.stringify(oneOff.evaluation));
check("vehiclesInAnyRule: company-wide rule returns every vehicle", m.vehiclesInAnyRule([rule], [devices.get("d1"), devices.get("d2")], expand).length === 2);


// ---- Warranty note in MyGeotab notes ----
{
  const covW = cov({ provider: "Peterbilt", policyNumber: "W48213", components: "Engine, transmission, axles", startDate: "2026-03-21", months: 36, startMeters: 50000 * MILE, limitMeters: 100000 * MILE });
  const woW = { ...wo, deviceId: "d1", lines: [{ id: "a", type: "labor", description: "x", qty: 2, unitCost: 95, warranty: true }, { id: "b", type: "part", description: "y", qty: 1, unitCost: 60, warranty: false }], warranty: { ...wo.warranty, eligible: true, coverageId: "c1", isWarrantyWork: true, claim: { ...wo.warranty.claim, status: "pending" } } };
  const note = m.warrantyNoteFor(woW, [covW], snap(60000), { ...S2, currency: "USD" }, now);
  check("warranty note names the coverage, end date and odometer limit", /^Warranty: Powertrain — Peterbilt #W48213 — Engine, transmission, axles\. Covered until Mar 21, 2029 \/ 150,000 mi\.$/m.test(note), note);
  check("warranty note carries the claim state and billed lines", /Claim: To be filed · 1 of 2 lines billed to warranty\./.test(note), note);
  const notClaimed = m.warrantyNoteFor({ ...woW, warranty: { ...woW.warranty, isWarrantyWork: false, claim: { ...woW.warranty.claim, status: "none" } } }, [covW], snap(60000), S2, now);
  check("in coverage but not claimed → says so", /Not claimed on this order\.$/.test(notClaimed) && /^Warranty:/.test(notClaimed), notClaimed);
  check("no coverage, not warranty work → no note", m.warrantyNoteFor({ ...woW, warranty: { ...woW.warranty, coverageId: null, isWarrantyWork: false } }, [], undefined, S2, now) === "");
  const expired = m.warrantyNoteFor(woW, [covW], snap(200000), S2, now);
  check("expired coverage flagged in the note", /\(EXPIRED\)/.test(expired), expired);
  const composed = m.composeNotes({ ...woW, title: "Brake job", description: "LR chamber", vendor: "", invoiceNumber: "" }, note);
  check("composeNotes appends the block after a marker; splitNotes strips it", composed.includes("\n——\nWarranty:") && m.splitNotes(composed).description === "LR chamber" && m.splitNotes(composed).title === "Brake job", composed);
  check("splitNotes also strips legacy trailing Source:/Vendor: lines", m.splitNotes("Oil change\n\nDue per reminder.\n\nSource: DVIR 2026-10-20\nVendor: Shop").description === "Due per reminder.");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
