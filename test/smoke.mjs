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
  let seq = 1000;
  const calls = [];
  window.__calls = calls;
  window.__store = store;
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
        case "StatusData": {
          const id = params.search?.deviceSearch?.id;
          const diag = params.search?.diagnosticSearch?.id;
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
const bannerText = await page.locator(".mwo-banners").innerText().catch(() => "");
if (!/Saved WO-/.test(bannerText)) fail(`expected save confirmation, saw: ${bannerText}`);

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
const completed = await page.evaluate(() => window.__store.find((r) => r.details?.data?.source?.type === "dvir" && r.details?.data?.status === "completed"));
if (!completed) fail("completed order not written back with status completed");
else if (completed.details.data.odometerAtClose == null) fail("odometer at close not captured on completion");
else step("order completed with odometer-at-close captured");

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

// Service schedules tab renders the due evaluation.
await page.getByRole("tab", { name: /Service schedules/ }).click();
await page.waitForSelector("text=Service schedules", { timeout: 5000 });
const schedRows = await page.locator(".mwo-table tbody tr").count();
if (schedRows < 1) fail("no schedules rendered");
else step(`service schedules tab lists ${schedRows} schedules`);

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
