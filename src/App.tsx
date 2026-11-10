/**
 * Maintenance Work Orders — top-level state and orchestration.
 *
 * System of record for work-order headers and reminders is Geotab's own
 * Maintenance Center (MaintenanceWorkOrder / MaintenanceWorkOrderJob /
 * MaintenanceSchedule — undocumented API, see api/maintenanceCenter.ts).
 * AddInData keeps what Geotab has no field for: parts & labor lines,
 * warranty eligibility + claim, category, due date, activity. The two are
 * merged per order on Geotab's id (utils/geotabMerge.ts).
 *
 * Load: session → groups + devices + users → Maintenance Center (rules,
 * orders, jobs) + AddInData (extras, coverages) → fleet-wide odometer /
 * engine-hours sweep for every vehicle a reminder, coverage or open order
 * references. Intake queues (DVIR defects, faults) load on demand.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banner, Button, ProgressBar, SearchInput, Tabs } from "@geotab/zenith";
import type {
  DvirDefectItem,
  FaultItem,
  GeotabApi,
  GeotabDevice,
  GeotabGroup,
  GeotabMaintenanceWorkOrder,
  GeotabPageState,
  GeotabSession,
  GeotabUser,
  Progress,
  ReminderJob,
  ReminderRule,
  ReminderVehicleRow,
  Settings,
  StoreData,
  VehicleSnapshot,
  WarrantyCoverage,
  WorkOrder,
  WorkOrderPriority,
  WorkOrderStatus,
} from "./types";
import { Pacer, fetchActiveDevices, fetchActiveFaults, fetchGroups, fetchOpenDvirDefects, fetchSession, fetchSnapshots, fetchUsers, friendlyError } from "./api/geotab";
import { AddInDataStore, MemoryStore, type Store } from "./api/store";
import { DemoMaintenanceClient, LiveMaintenanceClient, isUserReminder, sweepSnapshots, type MaintenanceClient } from "./api/maintenanceCenter";
import { makeDemoFleet } from "./utils/demo";
import { expandGroups } from "./utils/groups";
import { buildReminderRows, mergeWorkOrders, vehiclesInAnyRule } from "./utils/geotabMerge";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./utils/storage";
import { applyWarrantyEligibility, createWorkOrder, downloadText, formatNumber, fromDvirDefect, fromFault, fromReminder, matchesSearch, matchesView, PRIORITY_LABEL, STATUS_LABEL, VIEW_LABEL, woKey, workOrdersCsv, type ViewFilter } from "./utils/workorders";
import { todayIso } from "./utils/format";
import { warrantyNoteFor } from "./utils/warranty";
import { useFitToViewport } from "./utils/viewport";
import { AttentionTab, type AttentionView } from "./components/AttentionTab";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { GroupFilterPicker } from "./components/GroupFilterPicker";
import { RemindersTab } from "./components/RemindersTab";
import { Summary } from "./components/Summary";
import { CoveragePanel, WarrantyTab } from "./components/WarrantyTab";
import { WorkOrderPanel } from "./components/WorkOrderPanel";
import { WorkOrderTable } from "./components/WorkOrderTable";

interface AppProps {
  api: GeotabApi | null;
  pageState: GeotabPageState | null;
  /** Bumped by the add-in's focus() so a returning user gets fresh data. */
  focusNonce: number;
}

type MainTab = "orders" | "attention" | "warranty" | "reminders";

type Editor = { kind: "wo"; draft: WorkOrder; isNew: boolean } | { kind: "coverage"; draft: WarrantyCoverage; isNew: boolean } | null;

interface GeotabState {
  rules: ReminderRule[];
  orders: GeotabMaintenanceWorkOrder[];
  jobs: ReminderJob[];
  /** The database answered the Maintenance Center calls. */
  available: boolean;
  error: string | null;
}

/** Zenith Tabs print a bare "0" next to the label ("Warranty0") — omit the badge instead. */
export const badge = (n: number): number | undefined => (n > 0 ? n : undefined);

const EMPTY: StoreData = { workOrders: [], coverages: [], schedules: [] };
const EMPTY_GEOTAB: GeotabState = { rules: [], orders: [], jobs: [], available: false, error: null };
/** Per-device fallback cap inside the fleet-wide sweep. */
const DEEP_LOOKUP_MAX = 300;

export default function App({ api, pageState: _pageState, focusNonce }: AppProps) {
  const insideMyGeotab = api != null;

  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [session, setSession] = useState<GeotabSession | null>(null);
  const [groupsById, setGroupsById] = useState<Map<string, GeotabGroup>>(new Map());
  const [devices, setDevices] = useState<GeotabDevice[]>([]);
  const [users, setUsers] = useState<GeotabUser[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>(["GroupCompanyId"]);
  const [data, setData] = useState<StoreData>(EMPTY);
  const [geotab, setGeotab] = useState<GeotabState>(EMPTY_GEOTAB);
  const [snapshots, setSnapshots] = useState<Map<string, VehicleSnapshot>>(new Map());
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<MainTab>("orders");
  const [view, setView] = useState<ViewFilter>("active");
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<Editor>(null);
  const [attentionView, setAttentionView] = useState<AttentionView>("dvir");
  const [dvir, setDvir] = useState<DvirDefectItem[] | null>(null);
  const [faults, setFaults] = useState<FaultItem[] | null>(null);
  const [intakeLoading, setIntakeLoading] = useState(false);
  const [intakeError, setIntakeError] = useState<string | null>(null);
  const [readingsDone, setReadingsDone] = useState(false);

  const pageRef = useFitToViewport<HTMLDivElement>();
  const pacerRef = useRef(new Pacer(settings.callsPerMinute));
  const storeRef = useRef<Store | null>(null);
  const mcRef = useRef<MaintenanceClient | null>(null);
  const demoRef = useRef<ReturnType<typeof makeDemoFleet> | null>(null);
  const devicesRef = useRef<Map<string, GeotabDevice>>(new Map());
  const loadSeq = useRef(0);

  useEffect(() => {
    pacerRef.current.perMinute = settings.callsPerMinute;
    saveSettings(settings);
  }, [settings]);

  const devicesById = useMemo(() => {
    const m = new Map(devices.map((d) => [d.id, d]));
    devicesRef.current = m;
    return m;
  }, [devices]);
  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const currentUser = session?.userName ?? (insideMyGeotab ? "me" : "demo.user");
  const syncOn = settings.syncToGeotab && geotab.available;

  // -------------------------------------------------------------------------
  // Readings
  // -------------------------------------------------------------------------

  /** Fleet-wide sweep (few calls) for many vehicles; per-device for one or two. */
  const readReadings = useCallback(
    async (ids: string[], label = "Reading odometer & engine hours", deepMax = DEEP_LOOKUP_MAX) => {
      const todo = Array.from(new Set(ids)).filter((id) => devicesRef.current.has(id));
      if (!todo.length) return new Map<string, VehicleSnapshot>();
      if (!insideMyGeotab) {
        const m = new Map<string, VehicleSnapshot>();
        for (const id of todo) {
          const s = demoRef.current?.snapshots.get(id);
          if (s) m.set(id, s);
        }
        setSnapshots((prev) => new Map([...prev, ...m]));
        return m;
      }
      const onProgress = (text: string, pct: number | null) => setProgress({ text: `${label}: ${text}`, pct });
      const got = todo.length <= 10 ? await fetchSnapshots(api!, todo, pacerRef.current, onProgress) : await sweepSnapshots(api!, todo, pacerRef.current, onProgress, deepMax);
      setSnapshots((prev) => new Map([...prev, ...got]));
      return got;
    },
    [api, insideMyGeotab]
  );

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    setProgress({ text: "Loading…", pct: null });
    try {
      let store: Store;
      let mc: MaintenanceClient;
      let groups: Map<string, GeotabGroup>;
      let devs: GeotabDevice[];
      let usrs: GeotabUser[];
      if (insideMyGeotab) {
        const pacer = pacerRef.current;
        const s = await fetchSession(api!);
        setSession(s);
        setProgress({ text: "Loading groups, vehicles and users…", pct: null });
        [groups, devs, usrs] = await Promise.all([fetchGroups(api!, pacer), fetchActiveDevices(api!, pacer), fetchUsers(api!, pacer)]);
        store = new AddInDataStore(api!, pacer, () => devicesRef.current);
        mc = new LiveMaintenanceClient(api!, pacer);
      } else {
        const demo = demoRef.current ?? makeDemoFleet(36, 7, new Date());
        demoRef.current = demo;
        groups = new Map(demo.groups.map((g) => [g.id, g]));
        devs = demo.devices;
        usrs = demo.users;
        store = storeRef.current ?? new MemoryStore(demo.store);
        mc = mcRef.current ?? new DemoMaintenanceClient(demo.geotabSchedules, demo.geotabWorkOrders, demo.geotabJobs);
        setSession(null);
      }
      if (seq !== loadSeq.current) return;
      storeRef.current = store;
      mcRef.current = mc;
      devicesRef.current = new Map(devs.map((d) => [d.id, d]));
      setGroupsById(groups);
      setDevices(devs);
      setUsers(usrs);

      setProgress({ text: "Loading Maintenance Center (reminders, work orders, jobs) and add-in data…", pct: null });
      const [loaded, mcResult] = await Promise.all([
        store.load(),
        settings.syncToGeotab
          ? mc.loadAll().then((r) => ({ ...r, available: true, error: null as string | null })).catch((e) => ({ rules: [], orders: [], jobs: [], available: false, error: friendlyError(e) }))
          : Promise.resolve({ rules: [], orders: [], jobs: [], available: false, error: null as string | null }),
      ]);
      if (seq !== loadSeq.current) return;
      setData(loaded);
      setGeotab({ rules: mcResult.rules.filter(isUserReminder), orders: mcResult.orders, jobs: mcResult.jobs, available: mcResult.available, error: mcResult.error });
      if (!insideMyGeotab) {
        setDvir(demoRef.current!.dvir);
        setFaults(demoRef.current!.faults);
      }

      // Readings for every vehicle a reminder, coverage or active order references.
      const expand = (ids: string[]) => expandGroups(ids, groups);
      const refs = new Set<string>(vehiclesInAnyRule(mcResult.rules.filter(isUserReminder), devs, expand));
      for (const c of loaded.coverages) refs.add(c.deviceId);
      for (const w of loaded.workOrders) if (w.status !== "completed" && w.status !== "cancelled") refs.add(w.deviceId);
      for (const o of mcResult.orders) if (o.statusCode !== settings.statusCodeMap.completed && o.device?.id) refs.add(o.device.id);
      // The page is usable now; readings arrive in the background. Only the fleet-wide windows run here
      // (a handful of calls) — vehicles silent for 14+ days are looked up on demand, not on every load.
      setLoading(false);
      setProgress({ text: "Reading odometer & engine hours fleet-wide…", pct: null });
      try {
        await readReadings(Array.from(refs), "Reading odometer & engine hours", 0);
      } catch (e) {
        // Orders and reminders are already on screen; only the due maths is missing.
        if (seq === loadSeq.current) setNotice(`Couldn't read odometer / engine hours (${friendlyError(e)}) — reminders and warranty limits show as Unknown until you press Refresh.`);
      }
      if (seq !== loadSeq.current) return;
      setReadingsDone(true);
    } catch (e) {
      if (seq === loadSeq.current) setError(friendlyError(e));
    } finally {
      if (seq === loadSeq.current) {
        setLoading(false);
        setProgress(null);
      }
    }
  }, [api, insideMyGeotab, readReadings, settings.syncToGeotab, settings.statusCodeMap.completed]);

  useEffect(() => {
    void load();
  }, [load, focusNonce]);

  // -------------------------------------------------------------------------
  // Scope (group picker) and derived lists
  // -------------------------------------------------------------------------

  const expand = useCallback((ids: string[]) => expandGroups(ids, groupsById), [groupsById]);
  const scopedDeviceIds = useMemo(() => {
    if (!groupIds.length || groupIds.includes("GroupCompanyId")) return null; // everything
    const allowed = expand(groupIds);
    return new Set(devices.filter((d) => (d.groups ?? []).some((g) => allowed.has(g.id))).map((d) => d.id));
  }, [groupIds, expand, devices]);
  const inScope = useCallback((deviceId: string) => (scopedDeviceIds ? scopedDeviceIds.has(deviceId) : true), [scopedDeviceIds]);
  const scopedDevices = useMemo(() => devices.filter((d) => inScope(d.id)), [devices, inScope]);

  /** One list: Geotab headers ⨝ add-in extras, plus unsynced local orders. */
  const merged = useMemo(
    () => (syncOn ? mergeWorkOrders({ local: data.workOrders, geotab: geotab.orders, jobs: geotab.jobs, rules: geotab.rules, devicesById, usersById, settings }) : { workOrders: data.workOrders, orphaned: [] }),
    [syncOn, data.workOrders, geotab.orders, geotab.jobs, geotab.rules, devicesById, usersById, settings]
  );
  const allOrders = merged.workOrders;
  const workOrders = useMemo(() => allOrders.filter((w) => inScope(w.deviceId)), [allOrders, inScope]);
  const coverages = useMemo(() => data.coverages.filter((c) => inScope(c.deviceId)), [data.coverages, inScope]);

  const visibleOrders = useMemo(() => {
    const now = new Date();
    return workOrders.filter((w) => matchesView(w, view, now) && matchesSearch(w, search));
  }, [workOrders, view, search]);

  const activeByDvir = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of allOrders) {
      if (w.source.type !== "dvir" || w.status === "completed" || w.status === "cancelled") continue;
      if (w.source.defectId) m.set(`d:${w.source.defectId}`, woKey(w));
      if (w.source.refId) m.set(`l:${w.source.refId}`, woKey(w));
    }
    return m;
  }, [allOrders]);
  const activeByFault = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of allOrders) {
      if (w.source.type !== "fault" || w.status === "completed" || w.status === "cancelled") continue;
      if (w.source.diagnosticId) m.set(`${w.deviceId}|${w.source.diagnosticId}`, woKey(w));
    }
    return m;
  }, [allOrders]);
  const dvirRows = useMemo(() => (dvir ? dvir.filter((d) => inScope(d.deviceId)).map((d) => ({ ...d, openWorkOrderKey: activeByDvir.get(`d:${d.defectId}`) ?? activeByDvir.get(`l:${d.logId}`) ?? null })) : null), [dvir, inScope, activeByDvir]);
  const faultRows = useMemo(() => (faults ? faults.filter((f) => inScope(f.deviceId)).map((f) => ({ ...f, openWorkOrderKey: activeByFault.get(`${f.deviceId}|${f.diagnosticId}`) ?? null })) : null), [faults, inScope, activeByFault]);

  const geotabById = useMemo(() => new Map(geotab.orders.map((o) => [o.id, o])), [geotab.orders]);
  const reminderRows = useMemo<ReminderVehicleRow[]>(
    () => (syncOn ? buildReminderRows({ rules: geotab.rules, devices: scopedDevices, expand, jobs: geotab.jobs, geotabById, snapshots, settings }) : []),
    [syncOn, geotab.rules, geotab.jobs, scopedDevices, expand, geotabById, snapshots, settings]
  );
  const dueRows = useMemo(() => reminderRows.filter((r) => r.evaluation.state === "overdue" || r.evaluation.state === "due_soon"), [reminderRows]);
  /** Vehicles under a distance reminder that have a service on record but no odometer reading from the sweep. */
  const quietVehicleIds = useMemo(
    () => (readingsDone ? Array.from(new Set(reminderRows.filter((r) => r.rule.intervalMeters != null && r.lastDone && snapshots.get(r.deviceId)?.odometerMeters == null).map((r) => r.deviceId))) : []),
    [reminderRows, snapshots, readingsDone]
  );
  const readingsPending = quietVehicleIds.length;

  /** Per-vehicle lookups for vehicles the fleet-wide windows missed (capped; 2 calls each). */
  const fetchQuietReadings = useCallback(async () => {
    if (!insideMyGeotab || !quietVehicleIds.length) return;
    const ids = quietVehicleIds.slice(0, DEEP_LOOKUP_MAX);
    try {
      const got = await fetchSnapshots(api!, ids, pacerRef.current, (text, pct) => setProgress({ text, pct }));
      setSnapshots((prev) => new Map([...prev, ...got]));
    } catch (e) {
      setNotice(`Couldn't read the quiet vehicles: ${friendlyError(e)}`);
    } finally {
      setProgress(null);
    }
  }, [insideMyGeotab, api, quietVehicleIds]);

  // -------------------------------------------------------------------------
  // Intake refresh
  // -------------------------------------------------------------------------

  const refreshIntake = useCallback(async () => {
    if (!insideMyGeotab) {
      setDvir(demoRef.current?.dvir ?? []);
      setFaults(demoRef.current?.faults ?? []);
      return;
    }
    setIntakeLoading(true);
    setIntakeError(null);
    try {
      if (attentionView === "dvir") {
        setDvir(await fetchOpenDvirDefects(api!, pacerRef.current, groupIds, settings.dvirLookbackDays, groupsById, devicesById, usersById));
      } else if (attentionView === "faults") {
        setFaults(await fetchActiveFaults(api!, pacerRef.current, groupIds, settings.faultLookbackDays, devicesById));
      } else {
        await readReadings(reminderRows.map((r) => r.deviceId), "Refreshing readings");
      }
    } catch (e) {
      setIntakeError(friendlyError(e));
    } finally {
      setIntakeLoading(false);
      setProgress(null);
    }
  }, [insideMyGeotab, api, attentionView, groupIds, settings.dvirLookbackDays, settings.faultLookbackDays, groupsById, devicesById, usersById, readReadings, reminderRows]);

  useEffect(() => {
    if (tab !== "attention" || !insideMyGeotab) return;
    if (attentionView === "dvir" && dvir == null) void refreshIntake();
    if (attentionView === "faults" && faults == null) void refreshIntake();
  }, [tab, attentionView, dvir, faults, insideMyGeotab, refreshIntake]);

  // -------------------------------------------------------------------------
  // Editors
  // -------------------------------------------------------------------------

  const ensureSnapshot = useCallback(
    async (deviceId: string): Promise<VehicleSnapshot | undefined> => {
      const have = snapshots.get(deviceId);
      if (have && (have.odometerMeters != null || have.engineSeconds != null)) return have;
      try {
        const got = await readReadings([deviceId], "Reading vehicle");
        return got.get(deviceId);
      } catch (e) {
        setNotice(`Couldn't read odometer / engine hours for this vehicle: ${friendlyError(e)}`);
        return undefined;
      } finally {
        setProgress(null);
      }
    },
    [snapshots, readReadings]
  );

  const startWorkOrder = useCallback(
    async (deviceId: string, decorate?: (wo: WorkOrder) => WorkOrder) => {
      const device = devicesById.get(deviceId);
      if (!device) return;
      const snap = await ensureSnapshot(deviceId);
      let wo = createWorkOrder({ deviceId, deviceName: device.name ?? deviceId, by: currentUser, existing: data.workOrders, coverages: data.coverages, snapshot: snap, settings });
      if (decorate) wo = decorate(wo);
      setEditor({ kind: "wo", draft: wo, isNew: true });
    },
    [devicesById, ensureSnapshot, currentUser, data.workOrders, data.coverages, settings]
  );

  const newBlankWorkOrder = useCallback(() => {
    const wo = createWorkOrder({ deviceId: "", deviceName: "", by: currentUser, existing: data.workOrders, coverages: data.coverages, snapshot: undefined, settings });
    setEditor({ kind: "wo", draft: wo, isNew: true });
  }, [currentUser, data.workOrders, data.coverages, settings]);

  const changeWorkOrderVehicle = useCallback(
    async (deviceId: string) => {
      const device = devicesById.get(deviceId);
      if (!device) return;
      const snap = await ensureSnapshot(deviceId);
      setEditor((ed) => {
        if (!ed || ed.kind !== "wo") return ed;
        const next = applyWarrantyEligibility({ ...ed.draft, deviceId, deviceName: device.name ?? deviceId, odometerAtOpen: snap?.odometerMeters ?? null, engineSecondsAtOpen: snap?.engineSeconds ?? null }, data.coverages, snap, settings);
        return { ...ed, draft: next };
      });
    },
    [devicesById, ensureSnapshot, data.coverages, settings]
  );

  const openWorkOrder = useCallback(
    (key: string) => {
      const wo = allOrders.find((w) => woKey(w) === key);
      if (!wo) return;
      // A Geotab-only order has no AddInData record yet: evaluate warranty on open so the editor is useful.
      const draft = wo.id ? wo : applyWarrantyEligibility(wo, data.coverages, snapshots.get(wo.deviceId), settings);
      setEditor({ kind: "wo", draft, isNew: false });
    },
    [allOrders, data.coverages, snapshots, settings]
  );

  const runSave = useCallback(async (fn: () => Promise<string>) => {
    setSaving(true);
    setNotice(null);
    try {
      setNotice(await fn());
    } catch (e) {
      setNotice(`Save failed: ${friendlyError(e)}`);
    } finally {
      setSaving(false);
    }
  }, []);

  /** Refresh one Geotab header in state after a write. */
  const refreshGeotabOrder = useCallback(async (id: string) => {
    const mc = mcRef.current;
    if (!mc) return;
    const [fresh, jobs] = await Promise.all([mc.getOrder(id), mc.getJobs(id).catch(() => [] as ReminderJob[])]);
    setGeotab((g) => ({
      ...g,
      orders: fresh ? [fresh, ...g.orders.filter((o) => o.id !== id)] : g.orders.filter((o) => o.id !== id),
      jobs: [...g.jobs.filter((j) => j.workOrderId !== id), ...jobs],
    }));
  }, []);

  const saveWorkOrder = useCallback(async () => {
    if (!editor || editor.kind !== "wo" || !storeRef.current) return;
    const store = storeRef.current;
    const mc = mcRef.current;
    const now = new Date().toISOString();
    let wo: WorkOrder = { ...editor.draft, title: editor.draft.title.trim(), updatedAt: now, updatedBy: currentUser };
    if (!wo.id && !wo.geotab) {
      const taken = new Set(data.workOrders.map((w) => w.number));
      while (taken.has(wo.number)) wo = { ...wo, number: wo.number + 1 };
    }
    await runSave(async () => {
      let geotabNote = "";
      if (syncOn && mc) {
        const snap = snapshots.get(wo.deviceId);
        const rule = wo.source.type === "schedule" && wo.source.refId ? geotab.rules.find((r) => r.id === wo.source.refId) ?? null : null;
        try {
          const warrantyNote = warrantyNoteFor(wo, data.coverages, snap, settings);
          const res = wo.geotab ? await mc.update(wo, settings, snap, warrantyNote) : await mc.create(wo, settings, snap, rule, warrantyNote);
          wo = { ...wo, geotab: { id: res.id, reference: res.reference, statusCode: res.statusCode, jobId: res.jobId } };
          if (!wo.activity.some((a) => a.text.startsWith("Synced to MyGeotab"))) wo = { ...wo, activity: [...wo.activity, { at: now, by: currentUser, text: `Synced to MyGeotab Maintenance Center${res.reference ? ` as #${res.reference}` : ""}` }] };
        } catch (e) {
          // Keep the order in AddInData so nothing is lost; the list flags it as unsynced.
          geotabNote = ` MyGeotab sync failed: ${friendlyError(e)} — saved in the add-in only; open and save again to retry.`;
        }
      }
      const saved = await store.saveWorkOrder(wo);
      setData((d) => ({ ...d, workOrders: [saved, ...d.workOrders.filter((w) => w.id !== saved.id)].sort((a, b) => b.number - a.number) }));
      if (saved.geotab) await refreshGeotabOrder(saved.geotab.id);
      setEditor(null);
      return `Saved ${formatNumber(saved)}.${geotabNote}`;
    });
  }, [editor, currentUser, data.workOrders, data.coverages, runSave, syncOn, snapshots, geotab.rules, settings, refreshGeotabOrder]);

  const deleteWorkOrder = useCallback(async () => {
    if (!editor || editor.kind !== "wo" || !storeRef.current) return;
    const wo = editor.draft;
    await runSave(async () => {
      if (wo.geotab && syncOn && mcRef.current) {
        await mcRef.current.remove(wo.geotab.id);
        setGeotab((g) => ({ ...g, orders: g.orders.filter((o) => o.id !== wo.geotab!.id), jobs: g.jobs.filter((j) => j.workOrderId !== wo.geotab!.id) }));
      }
      if (wo.id) {
        await storeRef.current!.deleteWorkOrder(wo.id);
        setData((d) => ({ ...d, workOrders: d.workOrders.filter((w) => w.id !== wo.id) }));
      }
      setEditor(null);
      return `Deleted ${formatNumber(wo)}${wo.geotab && syncOn ? " here and in MyGeotab" : ""}.`;
    });
  }, [editor, runSave, syncOn]);

  const newCoverage = useCallback(
    (deviceId = "") => {
      const device = devicesById.get(deviceId);
      const now = new Date().toISOString();
      setEditor({
        kind: "coverage",
        isNew: true,
        draft: {
          deviceId,
          deviceName: device?.name ?? "",
          type: "manufacturer",
          provider: "",
          policyNumber: "",
          components: "",
          startDate: todayIso(),
          endDate: null,
          months: 36,
          startMeters: null,
          limitMeters: null,
          startEngineSeconds: null,
          limitEngineSeconds: null,
          notes: "",
          createdAt: now,
          createdBy: currentUser,
          updatedAt: now,
        },
      });
    },
    [devicesById, currentUser]
  );

  const changeCoverageVehicle = useCallback(
    async (deviceId: string) => {
      const device = devicesById.get(deviceId);
      if (!device) return;
      await ensureSnapshot(deviceId);
      setEditor((ed) => (ed && ed.kind === "coverage" ? { ...ed, draft: { ...ed.draft, deviceId, deviceName: device.name ?? deviceId } } : ed));
    },
    [devicesById, ensureSnapshot]
  );

  const saveCoverage = useCallback(async () => {
    if (!editor || editor.kind !== "coverage" || !storeRef.current) return;
    const c = { ...editor.draft, updatedAt: new Date().toISOString() };
    await runSave(async () => {
      const saved = await storeRef.current!.saveCoverage(c);
      setData((d) => ({ ...d, coverages: [...d.coverages.filter((x) => x.id !== saved.id), saved] }));
      setEditor(null);
      return "Coverage saved.";
    });
  }, [editor, runSave]);

  const deleteCoverage = useCallback(async () => {
    if (!editor || editor.kind !== "coverage" || !editor.draft.id) return;
    const id = editor.draft.id;
    await runSave(async () => {
      await storeRef.current!.deleteCoverage(id);
      setData((d) => ({ ...d, coverages: d.coverages.filter((x) => x.id !== id) }));
      setEditor(null);
      return "Coverage deleted.";
    });
  }, [editor, runSave]);

  const exportCsv = useCallback(() => {
    downloadText(`work-orders-${VIEW_LABEL[view].toLowerCase().replace(/\s+/g, "-")}-${todayIso()}.csv`, workOrdersCsv(visibleOrders, settings));
  }, [visibleOrders, settings, view]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const setSetting = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings((s) => ({ ...s, [k]: v }));
  const codeInput = (value: number, onChange: (n: number) => void) => <input className="mwo-input mwo-input-sm" type="number" min={0} value={value} onChange={(e) => onChange(parseInt(e.target.value, 10) || 0)} style={{ width: 72 }} />;

  return (
    <div className="mwo-page" ref={pageRef}>
      <div className="mwo-page-header">
        <div>
          <h2>Maintenance Work Orders</h2>
          <p>
            Work orders from DVIR defects, fault codes, MyGeotab reminders or by hand, with parts & labor, warranty eligibility and claims.
            {insideMyGeotab ? (syncOn ? " Orders live in MyGeotab's Maintenance Center; parts, warranty and activity in this database's Add-In Data." : " Stored in this database's Add-In Data.") : " Standalone preview with demo data — nothing is saved."}
          </p>
        </div>
        <div className="mwo-actions">
          {groupsById.size ? (
            <div className="mwo-groups-picker">
              <GroupFilterPicker groupsById={groupsById} initialGroupIds={groupIds} onChange={setGroupIds} onError={(e) => setNotice(e.message)} />
            </div>
          ) : null}
          <Button type="secondary" onClick={() => setShowSettings((s) => !s)}>
            {showSettings ? "Hide settings" : "Settings"}
          </Button>
          <Button type="secondary" onClick={() => void load()} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </Button>
          <Button type="primary" onClick={newBlankWorkOrder} disabled={loading || !devices.length}>
            + New work order
          </Button>
        </div>
      </div>

      {showSettings ? (
        <div className="mwo-card">
          <div className="mwo-card-head">
            <h3>Settings</h3>
            <Button type="tertiary" onClick={() => setSettings({ ...DEFAULT_SETTINGS })}>
              Reset to defaults
            </Button>
          </div>
          <div className="mwo-settings-grid">
            <label className="mwo-field">
              <span className="mwo-field-label">Distance units</span>
              <select className="mwo-input" value={settings.units} onChange={(e) => setSetting("units", e.target.value as Settings["units"])}>
                <option value="mi">Miles</option>
                <option value="km">Kilometres</option>
              </select>
            </label>
            <label className="mwo-field">
              <span className="mwo-field-label">Currency (ISO code)</span>
              <input className="mwo-input" value={settings.currency} onChange={(e) => setSetting("currency", e.target.value.toUpperCase().slice(0, 3) || "USD")} />
            </label>
            <label className="mwo-field">
              <span className="mwo-field-label">Default labor rate / hour</span>
              <input className="mwo-input" type="number" min={0} value={settings.laborRate} onChange={(e) => setSetting("laborRate", parseFloat(e.target.value) || 0)} />
            </label>
            <label className="mwo-field">
              <span className="mwo-field-label">DVIR look-back (days)</span>
              <input className="mwo-input" type="number" min={1} max={365} value={settings.dvirLookbackDays} onChange={(e) => setSetting("dvirLookbackDays", Math.max(1, parseInt(e.target.value, 10) || 30))} />
            </label>
            <label className="mwo-field">
              <span className="mwo-field-label">Fault look-back (days)</span>
              <input className="mwo-input" type="number" min={1} max={90} value={settings.faultLookbackDays} onChange={(e) => setSetting("faultLookbackDays", Math.max(1, parseInt(e.target.value, 10) || 7))} />
            </label>
            <label className="mwo-field">
              <span className="mwo-field-label">Warranty "expiring" within (days)</span>
              <input className="mwo-input" type="number" min={0} value={settings.expiringDays} onChange={(e) => setSetting("expiringDays", Math.max(0, parseInt(e.target.value, 10) || 0))} />
            </label>
            <label className="mwo-field">
              <span className="mwo-field-label">Warranty "expiring" within ({settings.units})</span>
              <input className="mwo-input" type="number" min={0} value={Math.round(settings.units === "mi" ? settings.expiringMeters / 1609.344 : settings.expiringMeters / 1000)} onChange={(e) => setSetting("expiringMeters", Math.max(0, parseFloat(e.target.value) || 0) * (settings.units === "mi" ? 1609.344 : 1000))} />
            </label>
            <label className="mwo-field">
              <span className="mwo-field-label">Reminder "due soon" at (% of interval)</span>
              <input className="mwo-input" type="number" min={50} max={100} value={Math.round(settings.dueSoonFraction * 100)} onChange={(e) => setSetting("dueSoonFraction", Math.min(1, Math.max(0.5, (parseInt(e.target.value, 10) || 90) / 100)))} />
            </label>
            <label className="mwo-field">
              <span className="mwo-field-label">API calls per minute (cap)</span>
              <input className="mwo-input" type="number" min={50} max={1000} value={settings.callsPerMinute} onChange={(e) => setSetting("callsPerMinute", Math.min(1000, Math.max(50, parseInt(e.target.value, 10) || 600)))} />
            </label>
          </div>
          <div className="mwo-card-head" style={{ marginTop: 14 }}>
            <h3>MyGeotab Maintenance Center</h3>
          </div>
          <label className="mwo-toggle">
            <input type="checkbox" checked={settings.syncToGeotab} onChange={(e) => setSetting("syncToGeotab", e.target.checked)} />
            Use MyGeotab's Maintenance Center for work orders and reminders (undocumented API — switch off to run on Add-In Data alone). Takes effect on Refresh.
          </label>
          <p className="mwo-muted mwo-small">
            Status / priority codes. <b>1 = open</b> and <b>5 = completed</b> are confirmed; the others are assumptions until checked against Maintenance Center. Set a status there, open the order here, and the raw code shows in the editor.
          </p>
          <div className="mwo-code-grid">
            {(Object.keys(STATUS_LABEL) as WorkOrderStatus[]).map((st) => (
              <label key={st} className="mwo-field">
                <span className="mwo-field-label">{STATUS_LABEL[st]} → statusCode</span>
                {codeInput(settings.statusCodeMap[st], (n) => setSetting("statusCodeMap", { ...settings.statusCodeMap, [st]: n }))}
              </label>
            ))}
            {(Object.keys(PRIORITY_LABEL) as WorkOrderPriority[]).map((p) => (
              <label key={p} className="mwo-field">
                <span className="mwo-field-label">{PRIORITY_LABEL[p]} → priorityCode / severity</span>
                <span className="mwo-actions">
                  {codeInput(settings.priorityCodeMap[p], (n) => setSetting("priorityCodeMap", { ...settings.priorityCodeMap, [p]: n }))}
                  {codeInput(settings.severityCodeMap[p], (n) => setSetting("severityCodeMap", { ...settings.severityCodeMap, [p]: n }))}
                </span>
              </label>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mwo-banners">
        {error ? (
          <Banner type="error" header="Couldn't load">
            {error}
          </Banner>
        ) : null}
        {settings.syncToGeotab && geotab.error ? (
          <Banner type="warning" header="MyGeotab Maintenance Center not reachable — running on Add-In Data only">
            {geotab.error} Work orders you save now stay in the add-in (flagged "unsynced") and can be synced later.
          </Banner>
        ) : null}
        {merged.orphaned.length ? (
          <Banner type="warning" header={`${merged.orphaned.length} add-in record${merged.orphaned.length === 1 ? "" : "s"} point to Maintenance Center orders that no longer exist`}>
            {merged.orphaned.map((w) => w.title || formatNumber(w)).slice(0, 5).join(" · ")}
            {merged.orphaned.length > 5 ? " …" : ""} — they were deleted in MyGeotab; their parts / warranty / activity are still in Add-In Data.
          </Banner>
        ) : null}
        {notice ? (
          <Banner type={/failed|couldn't/i.test(notice) ? "error" : "success"} onClose={() => setNotice(null)}>
            {notice}
          </Banner>
        ) : null}
        {progress ? (
          <div className="mwo-progress">
            <span>{progress.text}</span>
            {progress.pct != null ? (
              <div className="mwo-progress-bar">
                <ProgressBar now={progress.pct} min={0} max={100} />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="mwo-tabs-scroll">
        <Tabs
          tabs={[
            { id: "orders", name: "Work orders", quantity: badge(workOrders.filter((w) => w.status !== "completed" && w.status !== "cancelled").length) },
            { id: "attention", name: "Needs attention", quantity: badge((dvirRows?.filter((d) => !d.openWorkOrderKey).length ?? 0) + (faultRows?.filter((f) => !f.openWorkOrderKey).length ?? 0) + dueRows.filter((d) => !d.openWorkOrderId).length) },
            { id: "warranty", name: "Warranty", quantity: badge(coverages.length) },
            { id: "reminders", name: "Reminders", quantity: badge(geotab.rules.filter((r) => r.active).length) },
          ]}
          activeTabId={tab}
          onTabChange={(id) => setTab(id as MainTab)}
        />
      </div>

      <ErrorBoundary label="page">
        {tab === "orders" ? (
          <>
            <Summary rows={workOrders} settings={settings} active={view} onPick={(v) => setView((cur) => (cur === v ? "active" : v))} />
            <div className="mwo-toolbar">
              {(["active", "overdue", "warranty", "claims", "completed", "all"] as ViewFilter[]).map((v) => (
                <Button key={v} type={view === v ? "primary" : "tertiary"} onClick={() => setView(v)}>
                  {VIEW_LABEL[v]}
                </Button>
              ))}
              <span className="mwo-spacer" />
              <SearchInput value={search} onChange={(v) => setSearch(v)} placeholder="Search number, vehicle, work, assignee…" onClear={() => setSearch("")} />
              <Button type="secondary" onClick={exportCsv} disabled={!visibleOrders.length}>
                Export CSV
              </Button>
            </div>
            <WorkOrderTable rows={visibleOrders} settings={settings} session={session} busy={loading} syncOn={syncOn} onOpen={(wo) => openWorkOrder(woKey(wo))} />
          </>
        ) : null}

        {tab === "attention" ? (
          <AttentionTab
            view={attentionView}
            onView={setAttentionView}
            dvir={dvirRows}
            faults={faultRows}
            due={dueRows}
            loading={intakeLoading}
            error={intakeError}
            settings={settings}
            session={session}
            insideMyGeotab={insideMyGeotab}
            onRefresh={() => void refreshIntake()}
            onOpenWorkOrder={openWorkOrder}
            onCreateFromDvir={(item) => void startWorkOrder(item.deviceId, (wo) => fromDvirDefect(wo, item))}
            onCreateFromFault={(item) => void startWorkOrder(item.deviceId, (wo) => fromFault(wo, item))}
            onCreateFromReminder={(row) => void startWorkOrder(row.deviceId, (wo) => fromReminder(wo, row.rule))}
            workOrders={allOrders}
          />
        ) : null}

        {tab === "warranty" ? (
          <WarrantyTab coverages={coverages} workOrders={allOrders} snapshots={snapshots} devices={scopedDevices} settings={settings} session={session} busy={loading} onNew={() => newCoverage()} onEdit={(c) => setEditor({ kind: "coverage", draft: c, isNew: false })} onOpenWorkOrder={openWorkOrder} />
        ) : null}

        {tab === "reminders" ? (
          <RemindersTab
            rules={geotab.rules}
            rows={reminderRows}
            workOrders={allOrders}
            groupsById={groupsById}
            settings={settings}
            session={session}
            busy={loading}
            available={syncOn}
            error={geotab.error ?? (!settings.syncToGeotab ? "MyGeotab sync is switched off in Settings." : null)}
            readingsPending={readingsPending}
            onReadReadings={() => void fetchQuietReadings()}
            onCreateWorkOrder={(row) => void startWorkOrder(row.deviceId, (wo) => fromReminder(wo, row.rule))}
            onOpenWorkOrder={openWorkOrder}
          />
        ) : null}
      </ErrorBoundary>

      {editor?.kind === "wo" ? (
        <ErrorBoundary label="work order editor">
          <WorkOrderPanel
            draft={editor.draft}
            isNew={editor.isNew}
            saving={saving}
            devices={scopedDevices.length ? scopedDevices : devices}
            users={users}
            coverages={data.coverages}
            snapshots={snapshots}
            settings={settings}
            currentUser={currentUser}
            session={session}
            geotabSync={syncOn}
            onChange={(next) => setEditor((ed) => (ed && ed.kind === "wo" ? { ...ed, draft: next } : ed))}
            onChangeVehicle={(id) => void changeWorkOrderVehicle(id)}
            onSave={() => void saveWorkOrder()}
            onDelete={() => void deleteWorkOrder()}
            onClose={() => setEditor(null)}
          />
        </ErrorBoundary>
      ) : null}
      {editor?.kind === "coverage" ? (
        <ErrorBoundary label="coverage editor">
          <CoveragePanel draft={editor.draft} isNew={editor.isNew} saving={saving} devices={scopedDevices.length ? scopedDevices : devices} snapshots={snapshots} settings={settings} onChange={(next) => setEditor((ed) => (ed && ed.kind === "coverage" ? { ...ed, draft: next } : ed))} onChangeVehicle={(id) => void changeCoverageVehicle(id)} onSave={() => void saveCoverage()} onDelete={() => void deleteCoverage()} onClose={() => setEditor(null)} />
        </ErrorBoundary>
      ) : null}
    </div>
  );
}
