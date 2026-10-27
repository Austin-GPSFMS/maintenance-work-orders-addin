# Maintenance Work Orders — MyGeotab Add-In

Vite + React + TypeScript + Zenith MyGeotab add-in for creating, assigning and
tracking maintenance work orders, with per-vehicle warranty coverage and
claim tracking. Everything it writes is stored in the database's own
**AddInData**, so there is no backend: install the add-in and it works in any
MyGeotab database, respecting that database's security clearances and group
scoping.

Mirrors the stack and conventions of `vehicle-replacement-planner-addin`,
`recall-harness-swap-addin` and `intelligent-zoning-addin`.

## What it does

| Tab | What's there |
|---|---|
| **Work orders** | KPI tiles (open, in progress, overdue, warranty work, claims to chase, completed/30 days + fleet cost), view filters, search, sortable list, CSV export. Click a row to open the editor. |
| **Needs attention** | Three intake queues, each with a *Create work order* button that pre-fills the order and keeps the link back to the source: **DVIR defects** (unrepaired `DVIRDefect`s from `DVIRLog`s in the look-back window), **Active faults** (latest active, undismissed `FaultData` per vehicle + diagnostic, with diagnostic names resolved and cached), **Service due** (schedules that are overdue / due soon). A queue row that already has an open order shows the WO number instead. |
| **Warranty** | One row per coverage with its evaluated state today — Active · Expiring · Expired · Not started · Unknown — plus days / distance / hours left and the claims filed against it. Add / edit panel. |
| **Service schedules** | The add-in's own recurring maintenance reminders (distance, engine hours and/or days — whichever comes first). Completing an order created from a schedule rolls its "last done" forward automatically. |

### The work order editor (Zenith side panel)

Vehicle (searchable; readings for that vehicle are fetched on pick), work to
do, details, priority, category, assignee (any active MyGeotab user), due
date, vendor / shop, invoice #. Status workflow buttons: Open → Start work →
Complete, Put on hold / Resume, Cancel, Reopen — each transition is logged
and *Complete* captures odometer + engine hours at close (odometer / hours at
open are captured at creation). Parts & labor lines (labor · part · outside
service · fee · other; qty × unit cost; per-line **Warranty** checkbox) with
warranty / fleet / total split. Activity log with free-text notes.

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
  is flagged *eligible* and defaults to *warranty work* against that coverage;
  the user can switch it off, or pick another coverage. Eligibility is
  re-evaluated whenever the vehicle changes.
* **Claims** live on the work order: status (to be filed → submitted →
  approved / denied → paid), claim #, submitted / resolved dates, amount
  claimed, amount recovered, notes. The Warranty tab totals recovered amounts
  per coverage; the *Claims to chase* tile lists everything still pending.

### Why "service schedules" instead of MyGeotab's maintenance reminders

MyGeotab's built-in maintenance reminders are **not exposed through the
documented API** (Geotab community staff: "no supported APIs currently handle
reminders"), so the add-in keeps its own schedules in AddInData instead. They
are evaluated against the same live readings, so they behave like reminders
with a one-click path to a work order.

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
record per work order / coverage / schedule:

```json
{ "kind": "wo" | "coverage" | "schedule", "v": 1, "data": { ... } }
```

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

Load: Group ×1 · Device ×1 · User ×1 · AddInData ×1 · StatusData ×2 per
vehicle referenced by a coverage, schedule or active order (batched 50 per
multiCall, auto up to 300 vehicles — above that a banner offers to read them
on demand). DVIR queue: DVIRLog ×1. Faults: FaultData ×1 + Diagnostic ×1 per
unresolved diagnostic id (cached in localStorage). Every save: 1 call (+1
when completing a scheduled job). The `Pacer` keeps the rolling one-minute
count under the configurable cap (default 600; MyGeotab's limit is ~1000).

## Project layout

```
maintenance-work-orders-addin/
├── package.json · tsconfig.json · vite.config.ts (base = absolute Pages URL) · index.html
├── config.json             ← MyGeotab Add-In manifest
├── dist/                   ← committed build output served by GitHub Pages
├── test/
│   ├── run.mjs             ← 37 offline checks: warranty / schedule maths, factories, transitions, CSV (npm test)
│   ├── smoke.mjs           ← headless Chromium walk-through with a mocked MyGeotab api + AddInData store (npm run smoke)
│   └── rules-entry.ts
└── src/
    ├── main.tsx            ← lifecycle wiring (geotab.addin.maintenanceWorkOrders) + standalone preview
    ├── App.tsx             ← load, scope, intake, editors, save/delete
    ├── types.ts · styles.css
    ├── api/geotab.ts       ← apiCall/multiCall, Pacer, devices, users, snapshots, DVIR defects, faults, diagnostics
    ├── api/store.ts        ← AddInDataStore (+ MemoryStore for the preview)
    ├── components/         ← Summary, WorkOrderTable, WorkOrderPanel, AttentionTab, WarrantyTab(+CoveragePanel),
    │                          SchedulesTab(+SchedulePanel), VehiclePicker, fields, GroupFilterPicker, ErrorBoundary
    └── utils/              ← warranty.ts (pure evaluation), workorders.ts (factories/transitions/filters/CSV),
                               demo.ts, format.ts, groups.ts, storage.ts
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

1. `DVIRLog` → `dVIRDefects[].repairStatus` and `defect.id` resolve to names
   through the Group tree (defects are groups). If a database uses the newer
   inspection model and `DVIRLog` comes back empty, the queue will say so.
2. `FaultData.faultState` / `faultStates` values ("Active") and that
   `Get Diagnostic { search: { id } }` resolves names for the fault codes seen.
3. AddInData `details` comes back as an object (parsed) or a string (handled
   either way) and `groups` scoping behaves as expected for a site-scoped user.
