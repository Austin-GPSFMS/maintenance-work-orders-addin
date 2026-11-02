# Maintenance Work Orders — MyGeotab Add-In

Vite + React + TypeScript + Zenith MyGeotab add-in for creating, assigning and
tracking maintenance work orders, with per-vehicle warranty coverage and
claim tracking. Everything it writes is stored in the database's own
**AddInData**, so there is no backend: install the add-in and it works in any
MyGeotab database, respecting that database's security clearances and group
scoping.

Mirrors the stack and conventions of `vehicle-replacement-planner-addin`,
`recall-harness-swap-addin` and `intelligent-zoning-addin`.

## How it fits with MyGeotab's Maintenance Center

Geotab's own Maintenance Center (Maintenance → Reminders / Work orders) is
the **system of record** for work-order headers and reminder rules, through
three types that are not in the public API reference but work with a normal
session — `MaintenanceSchedule`, `MaintenanceWorkOrder`,
`MaintenanceWorkOrderJob` (confirmed on gpsfms_pilot 2026-10-28 with the
probes in `tools/`; see the project note *Geotab Maintenance Center —
undocumented API findings*). The add-in keeps in **AddInData** only what
Geotab has no field for — parts & labor lines, warranty eligibility and the
claim, category, due date, vendor / invoice, activity — in one "extras"
record per order keyed by Geotab's order id, and merges the two into one
list (`src/utils/geotabMerge.ts`).

* **Create / edit / complete** here → written to Geotab first (`Add` /
  `Set`), then the extras record. Status and priority are mapped through
  Settings (`statusCode` 1 = open and 5 = completed are confirmed; the rest
  are editable guesses until checked). Geotab assigns the reference number
  (`#000161`) that the list shows. A reminder-sourced order carries a job
  with the rule's `maintenanceType`, so Geotab counts it as that service.
* **Orders created in Maintenance Center** show up here too; opening and
  saving one creates its extras record ("adopts" it).
* **Reminders** are read from `MaintenanceSchedule` rules — group-scoped,
  with `kilometers` / `months` / `days` or a one-off `eventDate` — and
  evaluated per vehicle against the last completed job for that rule and
  the live odometer / engine hours. Rules are edited in MyGeotab, not here.
* If the Maintenance Center calls fail (or *Settings → Use MyGeotab's
  Maintenance Center* is off) the add-in runs on AddInData alone and flags
  orders as **unsynced**; saving them again once it is back syncs them.
* Geotab says this surface is "subject to change without notice", which is
  why every call is isolated in `src/api/maintenanceCenter.ts` and the
  fallback exists.

## What it does

| Tab | What's there |
|---|---|
| **Work orders** | KPI tiles (open, in progress, overdue, warranty work, claims to chase, completed/30 days + fleet cost), view filters, search, sortable list (cards on iPad), CSV export. Click a row to open the editor. |
| **Needs attention** | Three intake queues, each with a *Create work order* button that pre-fills the order and keeps the link back to the source: **DVIR defects** (unrepaired `DVIRDefect`s from `DVIRLog`s in the look-back window), **Active faults** (latest active, undismissed `FaultData` per vehicle + diagnostic, with diagnostic names resolved and cached), **Reminders due** (MyGeotab reminders that are overdue / due soon). A queue row that already has an open order shows its number instead. |
| **Warranty** | One row per coverage with its evaluated state today — Active · Expiring · Expired · Not started · Unknown — plus days / distance / hours left and the claims filed against it. Add / edit panel. |
| **Reminders** | MyGeotab's reminder rules, one accordion per rule with its interval, groups and labels, expanded to every vehicle in scope with last-done, due state and a one-click work order. |

### The work order editor (Zenith side panel)

Vehicle (searchable; readings for that vehicle are fetched on pick), work to
do, details, priority, category, assignee (any active MyGeotab user — written
to Geotab's `assignedTo`), due date, vendor / shop, invoice #. Status
workflow buttons: Open → Start work → Complete, Put on hold / Resume, Cancel,
Reopen — each transition is logged and *Complete* captures odometer + engine
hours at close (odometer / hours at open are captured at creation). Parts &
labor lines (labor · part · outside service · fee · other; qty × unit cost;
per-line **Warranty** checkbox) with warranty / fleet / total split — labor
and parts totals are also written to Geotab's `laborCost` / `partsCost`.
Activity log with free-text notes.

### Warranty

* **Coverage** is recorded per vehicle: type (manufacturer, powertrain,
  extended, emissions, component, aftermarket, other), provider, policy #,
  what's covered, start date, term in months or explicit end date, odometer at
  start + distance limit, engine hours at start + hours limit, notes.
* **Evaluation** uses the vehicle's latest *adjusted* odometer
  (`DiagnosticOdometerAdjustmentId`) and engine hours
  (`DiagnosticEngineHoursAdjustmentId`) — what MyGeotab displays. A coverage is
  *expiring* inside the configurable thresholds (default 60 days / 5,000 mi /
  100 h), *expired* once any limit is passed, *unknown* when a limit can't be
  checked because there's no reading.
* **Eligibility**: a work order on a vehicle with an active/expiring coverage
  is flagged *eligible* and defaults to *warranty work* against that coverage
  with the claim at "to be filed"; the user can switch it off, or pick
  another coverage. Eligibility is re-evaluated whenever the vehicle changes.
* **In MyGeotab too:** every synced order's notes end with a warranty block
  built from the coverage record, e.g.
  `Warranty: Powertrain — Peterbilt #W48213 — engine, transmission, axles.
  Covered until Mar 21, 2029 / 150,000 mi / 5,000 h.` followed by
  `Claim: To be filed · #CLM-1200 · $350.00 claimed · 2 of 3 lines billed to
  warranty.` (or `Not claimed on this order.`). An expired coverage is still
  mentioned, flagged `(EXPIRED)`, so nobody files a claim that can't pay. The
  editor previews the exact text; the block sits after a `——` marker so the
  add-in can strip it when it reads the order back.
* **Claims** live on the work order: status (to be filed → submitted →
  approved / denied → paid), claim #, submitted / resolved dates, amount
  claimed, amount recovered, notes. The Warranty tab totals recovered amounts
  per coverage; the *Claims to chase* tile lists everything still pending.

## iPad / MyGeotab mobile app

The MyGeotab app renders add-ins in a webview at iPad sizes with touch, so
the layout adapts (`src/utils/viewport.ts`: ≤1024 px, or any touch screen
≤1400 px): editors open full-screen with a sticky Close / Save bar, the
work-order table becomes a card list with a sort picker, parts & labor
lines stack into one block per line, tabs scroll sideways, and every
button / input / row grows to a 44 px tap target. Native date and number
inputs are used on purpose — they get the iPad's own pickers and keypad.
Verified with Playwright's iPad profiles in landscape and portrait.
*Export CSV* uses a Blob download, which some webviews ignore — treat it as
a desktop feature.

## Storage — AddInData

One fixed `addInId` (`asygz9FPN25G-GS0AyIqrkA`, `src/api/store.ts`); one
record per work order (the "extras" beside Geotab's header, with `geotab:
{id, reference, statusCode, jobId}`) and per coverage:

```json
{ "kind": "wo" | "coverage", "v": 1, "data": { ... } }
```

(`kind: "schedule"` records from pre-Maintenance-Center builds are still
parsed but no longer written or shown.)

* A record's `groups` are the vehicle's groups at save time (fallback
  `GroupCompanyId`), so a user scoped to a site sees the orders for the
  vehicles they can see.
* Records are capped at 9,000 characters (MyGeotab's per-record limit is
  10,000) — the editor refuses to save and says so rather than failing
  silently; trim the activity log if that ever happens.
* Work-order numbers are `max + 1` at creation, re-checked against the
  latest list on save. Two people creating at the exact same second could
  still collide; the number is cosmetic (the AddInData id is the key).
* **Security clearance**: users need *View Add-In Data* to see the page and
  *Administer Add-In Data* to create / edit (MyGeotab → Administration →
  Users → Clearances).

## API calls

Load: Group ×1 · Device ×1 · User ×1 · AddInData ×1 · MaintenanceSchedule ×1
· MaintenanceWorkOrder ×1 · MaintenanceWorkOrderJob ×1, then a **fleet-wide
readings sweep**: a handful of windowed `StatusData` calls per diagnostic
(−12 h / −3 d / −14 d, 50k rows each) for every vehicle a reminder, coverage
or open order references, plus one per-device lookup for vehicles silent
across all windows (capped at 300). DVIR queue: DVIRLog ×1. Faults: FaultData
×1 + Diagnostic ×1 per unresolved diagnostic id (cached). Every save: Add or
Set on MaintenanceWorkOrder + Get to re-read it + Get jobs + 1 AddInData
call. The `Pacer` keeps the rolling one-minute count under the configurable
cap (default 600; MyGeotab's limit is ~1000).

## Project layout

```
maintenance-work-orders-addin/
├── package.json · tsconfig.json · vite.config.ts (base = absolute Pages URL) · index.html
├── config.json             ← MyGeotab Add-In manifest
├── dist/                   ← committed build output served by GitHub Pages
├── test/
│   ├── run.mjs             ← 60 offline checks: warranty / reminder maths, merge, status codes, factories, CSV (npm test)
│   ├── smoke.mjs           ← headless Chromium walk-through with a mocked MyGeotab api + AddInData store (npm run smoke)
│   └── rules-entry.ts
└── src/
    ├── main.tsx            ← lifecycle wiring (geotab.addin.maintenanceWorkOrders) + standalone preview
    ├── App.tsx             ← load, scope, intake, editors, save/delete
    ├── types.ts · styles.css
    ├── api/geotab.ts       ← apiCall/multiCall, Pacer, devices, users, snapshots, DVIR defects, faults, diagnostics
    ├── api/maintenanceCenter.ts ← MaintenanceSchedule / WorkOrder / Job reads + writes, fleet-wide readings sweep, live + demo client
    ├── api/store.ts        ← AddInDataStore (+ MemoryStore for the preview)
    ├── components/         ← Summary, WorkOrderTable, WorkOrderPanel, AttentionTab, WarrantyTab(+CoveragePanel),
    │                          RemindersTab, VehiclePicker, fields, GroupFilterPicker, ErrorBoundary
    └── utils/              ← geotabMerge.ts (merge + reminder rows), warranty.ts (pure evaluation),
                               workorders.ts (factories/transitions/filters/CSV), demo.ts, format.ts, groups.ts, storage.ts, viewport.ts
tools/                      ← probe_geotab_api.py, probe_maintenance_center.py, probe_mc_jobs.py (API discovery scripts)
```

## Build & deploy

```
cd C:\Users\User\Projects\maintenance-work-orders-addin
npm install
npm run build        # tsc + vite → dist/
npm test             # offline maths
npm run smoke        # headless UI check (needs playwright + chromium)
```

Commit `dist/` and push to `github.com/Austin-GPSFMS/maintenance-work-orders-addin`
with GitHub Pages serving the repo root; install in MyGeotab with the
contents of `config.json` (Administration → System → System Settings →
Add-Ins → New Add-In). The page appears under the Add-Ins menu as
*Maintenance Work Orders*.

Opening `dist/index.html` directly (outside MyGeotab) renders a standalone
preview on a synthetic 36-vehicle fleet with demo orders, coverages,
schedules, DVIR defects and faults — nothing is saved.

## Things to verify on the first live database

1. Settings → status codes: set an order to each status in Maintenance
   Center, open it here, read the raw code shown in the editor, and fill the
   map (only 1 = open and 5 = completed are confirmed). Same for priority
   (`priorityCode`, default 100) and job severity (0 / 100 / 200 seen).
2. Reminders tab vs MyGeotab's own Reminders page for a few vehicles —
   "last done" comes from completed jobs, so a vehicle whose history predates
   Maintenance Center shows *Unknown* here.
3. `DVIRLog` → `dVIRDefects[].repairStatus` and `defect.id` resolve to names
   through the Group tree; `FaultData.faultState` is the string "Active".
4. AddInData `groups` scoping for a site-scoped user, and that the
   Maintenance Center calls work for the clearance your technicians use.
