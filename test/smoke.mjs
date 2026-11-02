/**
 * Headless smoke test: serves the built dist (with the absolute Pages base
 * rewritten to local paths) under a mocked MyGeotab `api` and walks the main
 * flows — load, open a work order, create one from a DVIR defect, save it to
 * (mock) AddInData, complete it, add a warranty coverage — checking the
 * page never blanks and the mock store receives the expected writes.
 *   npm run build && npm run smoke   (needs playwright + chromium)
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, mkdirSync, cpSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const site = resolve(here, ".build/site/dist");
const PAGES_BASE = "https://austin-gpsfms.github.io/maintenance-work-orders-addin/dist/";

// 1. Local copy of dist with the absolute base rewritten.
mkdirSync(site, { recursive: true });
cpSync(resolve(root, "dist"), site, { recursive: true });
for (const f of ["index.html", ...readdirSync(resolve(site, "assets")).map((a) => `assets/${a}`)]) {
  if (!/\.(html|js|css)$/.test(f)) continue;
  const p = resolve(site, f);
  writeFileSync(p, readFileSync(p, "utf8").split(PAGES_BASE).join("/"));
}

// 2. Demo fleet → fixture for the mocked API.
const bundle = resolve(here, ".build/rules.mjs");
await build({ entryPoints: [resolve(here, "rules-entry.ts")], bundle: true, format: "esm", platform: "node", outfile: bundle, logLevel: "silent" });
const m = await import(pathToFileURL(bundle).href);
const fleet = m.makeDemoFleet(Number(process.env.FLEET || 36), 7, new Date());
const addInId = m.ADDIN_DATA_ID;
const fixture = {
  groups: fleet.groups,
  devices: fleet.devices,
  users: fleet.users,
  snapshots: Object.fromEntries(fleet.snapshots),
  addInData: [
    ...fleet.store.workOrders.map((w, i) => ({ id: `aw${i}`, addInId, details: { kind: "wo", v: 1, data: { ...w, id: undefined } } })),
    ...fleet.store.coverages.map((c, i) => ({ id: `ac${i}`, addInId, details: { kind: "coverage", v: 1, data: { ...c, id: undefined } } })),
    ...fleet.store.schedules.map((s, i) => ({ id: `as${i}`, addInId, details: { kind: "schedule", v: 1, data: { ...s, id: undefined } } })),
  ],
  dvirLogs: fleet.dvir.map((d) => ({
    id: d.logId,
    dateTime: d.dateTime,
    device: { id: d.deviceId },
    driver: { id: "u-4" },
    isSafeToOperate: d.isSafeToOperate,
    driverRemark: "",
    dVIRDefects: [{ id: d.defectId, defect: { id: `defgrp-${d.defectName}` }, repairStatus: "NotRepaired", defectRemarks: [{ remark: d.remarks }] }],
  })),
  defectGroups: [...new Set(fleet.dvir.map((d) => d.defectName))].map((n) => ({ id: `defgrp-${n}`, name: n })),
  faults: fleet.faults.map((f) => ({ id: f.faultId, dateTime: f.dateTime, device: { id: f.deviceId }, diagnostic: { id: f.diagnosticId }, faultState: "Active", count: f.count, amberWarningLamp: f.lamps.includes("Amber"), redStopLamp: f.lamps.includes("Red stop") })),
  diagnostics: Object.fromEntries(fleet.faults.map((f) => [f.diagnosticId, { id: f.diagnosticId, name: f.name, code: f.code }])),
  // Maintenance Center (undocumented types), as MyGeotab returns them.
  schedules: fleet.geotabSchedules,
  geotabOrders: fleet.geotabWorkOrders,
  geotabJobs: fleet.geotabJobs,
};

const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".woff2": "font/woff2", ".woff": "font/woff", ".otf": "font/otf", ".map": "application/json" };
const server = createServer((req, res) => {
  const p = resolve(site, "." + (req.url === "/" ? "/index.html" : req.url.split("?")[0]));
  if (!existsSync(p) || statSync(p).isDirectory()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": types[extname(p)] ?? "application/octet-stream" });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(5182, r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});

await page.addInitScript((fx) => {
  const store = [...fx.addInData];
  const mc = { orders: [...fx.geotabOrders], jobs: [...fx.geotabJobs] };
  let seq = 1000;
  let ref = 500;
  const calls = [];
  window.__calls = calls;
  window.__store = store;
  window.__mc = mc;
  function answer(method, params) {
    calls.push([method, params?.typeName ?? method]);
    if (method === "Get") {
      switch (params.typeName) {
        case "Group":
          return [...fx.groups, ...fx.defectGroups];
        case "Device":
          return fx.devices;
        case "User":
          return fx.users;
        case "AddInData":
          return store.filter((r) => r.addInId === params.search?.addInId);
        case "MaintenanceSchedule":
          return fx.schedules;
        case "MaintenanceWorkOrder":
          return params.search?.id ? mc.orders.filter((o) => o.id === params.search.id) : mc.orders;
        case "MaintenanceWorkOrderJob":
          return mc.jobs;
        case "StatusData": {
          const id = params.search?.deviceSearch?.id;
          const diag = params.search?.diagnosticSearch?.id;
          if (!id) {
            // Fleet-wide window: every vehicle's latest reading (the demo stamps them "now").
            const from = new Date(params.search.fromDate).getTime();
            const to = new Date(params.search.toDate).getTime();
            const out = [];
            for (const [did, s] of Object.entries(fx.snapshots)) {
              const v = diag === "DiagnosticOdometerAdjustmentId" ? s.odometerMeters : s.engineSeconds;
              const at = diag === "DiagnosticOdometerAdjustmentId" ? s.odometerAt : s.engineAt;
              const t = new Date(at).getTime();
              if (v != null && t >= from && t <= to) out.push({ device: { id: did }, diagnostic: { id: diag }, dateTime: at, data: v });
            }
            return out;
          }
          const s = fx.snapshots[id];
          if (!s) return [];
          if (diag === "DiagnosticOdometerAdjustmentId") return s.odometerMeters == null ? [] : [{ device: { id }, diagnostic: { id: diag }, dateTime: s.odometerAt, data: s.odometerMeters }];
          return s.engineSeconds == null ? [] : [{ device: { id }, diagnostic: { id: diag }, dateTime: s.engineAt, data: s.engineSeconds }];
        }
        case "DVIRLog":
          return fx.dvirLogs;
        case "FaultData":
          return fx.faults;
        case "Diagnostic":
          return fx.diagnostics[params.search?.id] ? [fx.diagnostics[params.search.id]] : [];
      }
      return [];
    }
    if (params?.typeName === "MaintenanceWorkOrder") {
      const e = params.entity;
      if (method === "Add") {
        if (new Date(e.dateTime).getTime() > Date.now()) throw new Error("WorkOrder.DateTime cannot be in the future");
        const id = `gwo-new-${seq++}`;
        ref += 1;
        const { workJobs, jobCount, ...header } = e;
        mc.orders.push({ ...header, id, reference: String(ref).padStart(6, "0"), updatedDate: new Date().toISOString(), openedByUser: { id: "u-x", name: "tech@demo" } });
        for (const j of workJobs ?? []) mc.jobs.push({ ...j, id: `job-new-${seq++}`, workOrder: { id } });
        return id;
      }
      if (method === "Set") {
        const i = mc.orders.findIndex((o) => o.id === e.id);
        if (i < 0) throw new Error("Set: unknown MaintenanceWorkOrder " + e.id);
        mc.orders[i] = { ...mc.orders[i], ...e, updatedDate: new Date().toISOString() };
        return null;
      }
      if (method === "Remove") {
        const i = mc.orders.findIndex((o) => o.id === e.id);
        if (i >= 0) mc.orders.splice(i, 1);
        return null;
      }
    }
    if (method === "Add") {
      const id = `new-${seq++}`;
      store.push({ ...params.entity, id });
      return id;
    }
    if (method === "Set") {
      const i = store.findIndex((r) => r.id === params.entity.id);
      if (i < 0) throw new Error("Set: unknown id " + params.entity.id);
      store[i] = { ...params.entity };
      return null;
    }
    if (method === "Remove") {
      const i = store.findIndex((r) => r.id === params.entity.id);
      if (i >= 0) store.splice(i, 1);
      return null;
    }
    throw new Error("Unmocked method " + method);
  }
  const api = {
    call(method, params, ok, fail) {
      try {
        const r = answer(method, params);
        setTimeout(() => ok(r), 2);
      } catch (e) {
        setTimeout(() => fail(e), 2);
      }
    },
    multiCall(list, ok, fail) {
      try {
        const out = list.map(([m, p]) => answer(m, p));
        setTimeout(() => ok(out), 2);
      } catch (e) {
        setTimeout(() => fail(e), 2);
      }
    },
    getSession(cb) {
      cb({ database: "demo_db", userName: "tech@demo", sessionId: "s" }, "my.geotab.com");
    },
  };
  window.addEventListener("DOMContentLoaded", () => {
    const tryInit = () => {
      const factory = window.geotab?.addin?.maintenanceWorkOrders;
      if (!factory) return setTimeout(tryInit, 20);
      const addin = factory();
      addin.initialize(api, {}, () => addin.focus(api, {}));
    };
    tryInit();
  });
}, fixture);

const step = (name) => console.log(`• ${name}`);
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};

await page.goto("http://localhost:5182/index.html");
await page.waitForSelector(".mwo-page", { timeout: 15000 });
step("page rendered inside the mocked MyGeotab lifecycle");

// Load completes: tiles + table rows.
await page.waitForSelector(".mwo-table .mwo-row", { timeout: 20000 });
const rowCount = await page.locator(".mwo-table .mwo-row").count();
if (rowCount < 3) fail(`expected active work orders in the table, got ${rowCount}`);
step(`work-order table shows ${rowCount} active orders`);
if ((await page.locator("text=Standalone preview").count()) > 0) fail("page thinks it's standalone although api was supplied");

// Open an existing order and check the panel.
await page.locator(".mwo-table .mwo-row").first().click();
await page.waitForSelector(".mwo-panel", { timeout: 5000 });
step("work order editor opened");
const panelText = await page.locator(".mwo-panel").innerText();
if (!/Parts & labor/i.test(panelText)) fail("editor missing parts & labor section");
await page.locator(".mwo-panel-footer button:has-text('Close')").click();
await page.waitForSelector(".mwo-panel", { state: "detached", timeout: 5000 });

// Needs attention → DVIR → create a work order from a defect and save it.
await page.getByRole("tab", { name: /Needs attention/ }).click();
await page.waitForSelector("text=Create work order", { timeout: 20000 });
const dvirRows = await page.locator(".mwo-table tbody tr").count();
step(`DVIR queue shows ${dvirRows} open defects`);
const before = await page.evaluate(() => window.__store.length);
const mcBefore = await page.evaluate(() => window.__mc.orders.length);
await page.locator("button:has-text('Create work order')").first().click();
await page.waitForSelector(".mwo-panel", { timeout: 5000 });
const draftText = await page.locator(".mwo-panel").innerText();
if (!/DVIR/.test(draftText)) fail("draft from DVIR defect is missing its source banner");
step("draft from DVIR defect prefilled");
await page.locator("button:has-text('+ Labor')").click();
await page.locator("button:has-text('Create work order')").last().click();
await page.waitForSelector(".mwo-panel", { state: "detached", timeout: 10000 });
const after = await page.evaluate(() => window.__store.length);
if (after !== before + 1) fail(`expected one AddInData Add (store ${before} → ${after})`);
else step("new work order written to AddInData (mock)");
const saved = await page.evaluate(() => window.__store[window.__store.length - 1]);
if (saved.details?.kind !== "wo" || saved.details?.data?.source?.type !== "dvir") fail("saved record is not a dvir-sourced work order envelope");
if (!Array.isArray(saved.groups) || !saved.groups.length) fail("saved record has no groups");
const mcAfter = await page.evaluate(() => window.__mc.orders.length);
if (mcAfter !== mcBefore + 1) fail(`expected one MaintenanceWorkOrder Add (orders ${mcBefore} → ${mcAfter})`);
else step("new work order also written to MyGeotab Maintenance Center (mock)");
const gwo = await page.evaluate(() => window.__mc.orders[window.__mc.orders.length - 1]);
if (!saved.details.data.geotab || saved.details.data.geotab.id !== gwo.id) fail("AddInData record is not linked to the Geotab order id");
if (gwo.statusCode !== 1 || !/Source: DVIR/.test(gwo.notes ?? "")) fail(`Geotab header wrong: status ${gwo.statusCode}, notes ${JSON.stringify(gwo.notes)}`);
else step(`Geotab order #${gwo.reference} has statusCode 1 and the DVIR source in notes`);
// Vehicles with coverage get the warranty block in the Geotab notes.
// A DVIR row on a vehicle that has warranty coverage → the Geotab notes carry the warranty block.
const coveredIds = await page.evaluate(() => window.__store.filter((r) => r.details?.kind === "coverage").map((r) => r.details.data.deviceId));
const coveredName = fixture.devices.find((d) => coveredIds.includes(d.id) && fleet.dvir.some((x) => x.deviceId === d.id))?.name;
if (!coveredName) fail("demo has no DVIR defect on a vehicle with coverage");
else {
  const row = page.locator(".mwo-table tbody tr", { hasText: coveredName }).first();
  await row.locator("button:has-text('Create work order')").click();
  await page.waitForSelector(".mwo-panel", { timeout: 5000 });
  const preview = await page.locator(".mwo-note-preview").innerText().catch(() => "");
  if (!/Warranty: /.test(preview)) fail(`editor shows no warranty-note preview for ${coveredName}: ${preview}`);
  await page.locator("button:has-text('Create work order')").last().click();
  await page.waitForSelector(".mwo-panel", { state: "detached", timeout: 10000 });
  const g2 = await page.evaluate(() => window.__mc.orders[window.__mc.orders.length - 1]);
  if (!/\n——\n[\s\S]*Warranty: .*Covered until /.test(g2.notes ?? "")) fail(`Geotab notes missing the warranty block: ${JSON.stringify(g2.notes)}`);
  else step(`warranty block written to Geotab notes for ${coveredName}: ${(g2.notes.match(/Warranty: [^\n]*/) ?? [""])[0].slice(0, 90)}…`);
}
const bannerText = await page.locator(".mwo-banners").innerText().catch(() => "");
if (!/Saved #\d+/.test(bannerText)) fail(`expected save confirmation with the Geotab reference, saw: ${bannerText}`);

// The DVIR row should now link to the new order instead of offering to create one.
const linkCount = await page.locator(".mwo-table tbody tr button.mwo-link").count();
if (linkCount < 1) fail("DVIR row did not switch to the existing work-order link");
else step("DVIR row now links to the new work order");

// Faults queue renders with resolved diagnostic names.
await page.getByRole("tab", { name: /Active faults/ }).click();
await page.waitForSelector("text=SPN 3251", { timeout: 20000 });
step("fault queue shows resolved diagnostic names");

// Complete the new order: open via the DVIR row link, press Complete, save.
await page.getByRole("tab", { name: /DVIR defects/ }).click();
await page.waitForSelector(".mwo-table tbody tr button.mwo-link", { timeout: 10000 });
await page.locator(".mwo-table tbody tr button.mwo-link").first().click();
await page.waitForSelector(".mwo-panel", { timeout: 5000 });
await page.locator("button:has-text('Start work')").click();
await page.locator("button:has-text('Complete')").first().click();
await page.locator("button:has-text('Save changes')").click();
await page.waitForSelector(".mwo-panel", { state: "detached", timeout: 10000 });
const completed = await page.evaluate((gid) => window.__store.find((r) => r.details?.data?.geotab?.id === gid), gwo.id);
if (!completed) fail("completed order not written back with status completed");
else if (completed.details.data.odometerAtClose == null) fail("odometer at close not captured on completion");
else step("order completed with odometer-at-close captured");
const gDone = await page.evaluate((id) => window.__mc.orders.find((o) => o.id === id), completed?.details?.data?.geotab?.id ?? "");
if (!gDone || gDone.statusCode !== 5 || !gDone.completedDateTime) fail(`Geotab order not set to completed: ${JSON.stringify(gDone && { statusCode: gDone.statusCode, completedDateTime: gDone.completedDateTime })}`);
else step("Geotab order Set to statusCode 5 with completedDateTime");

// A Geotab-only order (created in Maintenance Center) is listed and can be adopted by saving it.
await page.getByRole("tab", { name: /Work orders/ }).click();
await page.waitForSelector(".mwo-table .mwo-row", { timeout: 5000 });
await page.locator("button:has-text('All')").click();
const adopt = page.locator(".mwo-table .mwo-row", { hasText: "Replace wiper blades" });
if ((await adopt.count()) === 0) fail("Geotab-only order 'Replace wiper blades' not listed");
else {
  await adopt.first().click();
  await page.waitForSelector(".mwo-panel", { timeout: 5000 });
  const txt = await page.locator(".mwo-panel").innerText();
  if (!/MyGeotab #\d+/.test(txt)) fail("adopted order editor does not show its Geotab reference");
  const sb = await page.evaluate(() => window.__store.length);
  await page.locator("button:has-text('+ Part')").click();
  await page.locator("button:has-text('Save changes')").click();
  await page.waitForSelector(".mwo-panel", { state: "detached", timeout: 10000 });
  const sa = await page.evaluate(() => window.__store.length);
  if (sa !== sb + 1) fail("adopting a Geotab-only order did not create its AddInData record");
  else step("Geotab-only order adopted: AddInData extras record created and linked");
}

// Warranty tab → add coverage for a vehicle without one.
await page.getByRole("tab", { name: /^Warranty/ }).click();
await page.waitForSelector("text=Warranty coverage", { timeout: 5000 });
const covRows = await page.locator(".mwo-table tbody tr").count();
step(`warranty tab lists ${covRows} coverages with evaluated status`);
const statusText = await page.locator(".mwo-table tbody").innerText();
if (!/Active|Expiring|Expired/.test(statusText)) fail("coverage rows show no evaluated state");

await page.locator("button:has-text('+ Add coverage')").click();
await page.waitForSelector(".mwo-panel", { timeout: 5000 });
// Pick a vehicle through the Zenith dropdown search.
await page.locator(".mwo-panel .zen-dropdown button, .mwo-panel [class*='dropdown'] button").first().click();
await page.keyboard.type("WAC-104");
await page.waitForTimeout(300);
await page.locator("text=WAC-104").last().click();
await page.waitForTimeout(300);
await page.locator(".mwo-panel input[type='number']").first().fill("36");
const storeBefore = await page.evaluate(() => window.__store.length);
await page.locator("button:has-text('Add coverage')").last().click();
await page.waitForSelector(".mwo-panel", { state: "detached", timeout: 10000 });
const storeAfter = await page.evaluate(() => window.__store.length);
if (storeAfter !== storeBefore + 1) fail("coverage was not added to AddInData");
else step("warranty coverage added");

// Reminders tab: MyGeotab rules, expand one, create a work order from a due vehicle (→ Add with a job).
await page.evaluate(() => window.scrollTo(0, 0));
await page.getByRole("tab", { name: /^Reminders/ }).click();
await page.waitForSelector("h3:has-text('Reminders')", { timeout: 5000 });
const ruleCount = await page.locator(".mwo-rule").count();
if (ruleCount !== 3) fail(`expected 3 user reminder rules (Data Insight filtered out), got ${ruleCount}`);
else step("reminders tab lists the 3 MyGeotab rules (insight rule filtered out)");
await page.locator("button:has-text('Overdue')").first().click();
await page.locator(".mwo-rule-head").first().click();
await page.waitForSelector(".mwo-rule .mwo-table tbody tr", { timeout: 5000 });
const overdueRows = await page.locator(".mwo-rule .mwo-table tbody tr").count();
if (overdueRows < 1) fail("no overdue vehicles under the first rule");
else step(`${overdueRows} overdue vehicles under the first rule`);
const jobsBefore = await page.evaluate(() => window.__mc.jobs.length);
await page.locator(".mwo-rule .mwo-table button:has-text('Create work order')").first().click();
await page.waitForSelector(".mwo-panel", { timeout: 5000 });
const remDraft = await page.locator(".mwo-panel").innerText();
if (!/Reminder — /.test(remDraft)) fail("reminder draft missing its source");
await page.locator("button:has-text('Create work order')").last().click();
await page.waitForSelector(".mwo-panel", { state: "detached", timeout: 10000 });
const jobsAfter = await page.evaluate(() => window.__mc.jobs.length);
const lastJob = await page.evaluate(() => window.__mc.jobs[window.__mc.jobs.length - 1]);
if (jobsAfter !== jobsBefore + 1 || !lastJob?.schedule?.id || !lastJob?.maintenanceType?.id) fail(`expected a MaintenanceWorkOrderJob linked to the rule, got ${JSON.stringify(lastJob)}`);
else step(`reminder order created with a job on schedule ${lastJob.schedule.id}`);
const linkedRow = await page.locator(".mwo-rule .mwo-table tbody tr button.mwo-link").count();
if (linkedRow < 1) fail("reminder row did not switch to the open-order link");
else step("reminder row now links to the open order");

await page.screenshot({ path: resolve(here, ".build/smoke.png"), fullPage: true });
const apiCalls = await page.evaluate(() => window.__calls.length);
step(`${apiCalls} mocked API calls in total`);

const realErrors = errors.filter((e) => !/Download the React DevTools|act\(|favicon/.test(e));
if (realErrors.length) {
  fail(`console/page errors:\n  ${realErrors.join("\n  ")}`);
}
await browser.close();
server.close();
console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE OK");
