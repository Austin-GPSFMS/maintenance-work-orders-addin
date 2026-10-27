/**
 * Maintenance Work Orders — top-level state and orchestration.
 *
 * Load: session → groups + devices + users → AddInData (work orders,
 * coverages, schedules) → odometer / engine-hours snapshot for every vehicle
 * those records reference. Intake queues (DVIR defects, faults) load on
 * demand. Editors are Zenith side panels whose drafts live here so a vehicle
 * change can fetch that vehicle's readings and re-run warranty eligibility.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banner, Button, ProgressBar, SearchInput, Tabs } from "@geotab/zenith";
import type {
  DvirDefectItem,
  FaultItem,
  GeotabApi,
  GeotabDevice,
  GeotabGroup,
  GeotabPageState,
  GeotabSession,
  GeotabUser,
  Progress,
  ServiceSchedule,
  Settings,
  StoreData,
  VehicleSnapshot,
  WarrantyCoverage,
  WorkOrder,
} from "./types";
import { Pacer, fetchActiveDevices, fetchActiveFaults, fetchGroups, fetchOpenDvirDefects, fetchSession, fetchSnapshots, fetchUsers, friendlyError } from "./api/geotab";
import { AddInDataStore, MemoryStore, type Store } from "./api/store";
import { makeDemoFleet } from "./utils/demo";
import { expandGroups } from "./utils/groups";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./utils/storage";
import { applyWarrantyEligibility, createWorkOrder, downloadText, fromDvirDefect, fromFault, fromSchedule, matchesSearch, matchesView, rollSchedule, VIEW_LABEL, workOrdersCsv, type ViewFilter } from "./utils/workorders";
import { todayIso } from "./utils/format";
import { AttentionTab, type AttentionView } from "./components/AttentionTab";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { GroupFilterPicker } from "./components/GroupFilterPicker";
import { SchedulePanel, SchedulesTab, evaluateAll } from "./components/SchedulesTab";
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

type MainTab = "orders" | "attention" | "warranty" | "schedules";

type Editor =
  | { kind: "wo"; draft: WorkOrder; isNew: boolean }
  | { kind: "coverage"; draft: WarrantyCoverage; isNew: boolean }
  | { kind: "schedule"; draft: ServiceSchedule; isNew: boolean }
  | null;

/** Auto-read readings for at most this many vehicles on load (2 calls each). */
const AUTO_SNAPSHOT_MAX = 300;
const EMPTY: StoreData = { workOrders: [], coverages: [], schedules: [] };

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
  const [pendingSnapshots, setPendingSnapshots] = useState<string[]>([]);

  const pacerRef = useRef(new Pacer(settings.callsPerMinute));
  const storeRef = useRef<Store | null>(null);
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

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  const readSnapshots = useCallback(
    async (ids: string[], label = "Reading vehicle odometer & engine hours") => {
      const todo = Array.from(new Set(ids)).filter(Boolean);
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
      const got = await fetchSnapshots(api!, todo, pacerRef.current, (text, pct) => setProgress({ text: `${label}: ${text}`, pct }));
      setSnapshots((prev) => new Map([...prev, ...got]));
      return got;
    },
    [api, insideMyGeotab]
  );

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    setProgress({ text: "Loading…", pct: null });
    try {
      let store: Store;
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
      } else {
        const demo = demoRef.current ?? makeDemoFleet(36, 7, new Date());
        demoRef.current = demo;
        groups = new Map(demo.groups.map((g) => [g.id, g]));
        devs = demo.devices;
        usrs = demo.users;
        store = storeRef.current ?? new MemoryStore(demo.store);
        setSession(null);
      }
      if (seq !== loadSeq.current) return;
      storeRef.current = store;
      devicesRef.current = new Map(devs.map((d) => [d.id, d]));
      setGroupsById(groups);
      setDevices(devs);
      setUsers(usrs);
      setProgress({ text: "Loading work orders, warranties and schedules…", pct: null });
      const loaded = await store.load();
      if (seq !== loadSeq.current) return;
      setData(loaded);
      // Readings for every vehicle the records reference (bounded).
      const refs = new Set<string>();
      for (const c of loaded.coverages) refs.add(c.deviceId);
      for (const s of loaded.schedules) refs.add(s.deviceId);
      for (const w of loaded.workOrders) if (w.status !== "completed" && w.status !== "cancelled") refs.add(w.deviceId);
      const ids = Array.from(refs).filter((id) => devicesRef.current.has(id));
      if (ids.length <= AUTO_SNAPSHOT_MAX) {
        await readSnapshots(ids);
        setPendingSnapshots([]);
      } else {
        setPendingSnapshots(ids);
      }
      if (!insideMyGeotab) {
        setDvir(demoRef.current!.dvir);
        setFaults(demoRef.current!.faults);
      }
    } catch (e) {
      if (seq === loadSeq.current) setError(friendlyError(e));
    } finally {
      if (seq === loadSeq.current) {
        setLoading(false);
        setProgress(null);
      }
    }
  }, [api, insideMyGeotab, readSnapshots]);

  useEffect(() => {
    void load();
  }, [load, focusNonce]);

  // -------------------------------------------------------------------------
  // Scope (group picker) and derived lists
  // -------------------------------------------------------------------------

  const scopedDeviceIds = useMemo(() => {
    if (!groupIds.length || groupIds.includes("GroupCompanyId")) return null; // everything
    const allowed = expandGroups(groupIds, groupsById);
    return new Set(devices.filter((d) => (d.groups ?? []).some((g) => allowed.has(g.id))).map((d) => d.id));
  }, [groupIds, groupsById, devices]);
  const inScope = useCallback((deviceId: string) => (scopedDeviceIds ? scopedDeviceIds.has(deviceId) : true), [scopedDeviceIds]);
  const scopedDevices = useMemo(() => devices.filter((d) => inScope(d.id)), [devices, inScope]);

  const workOrders = useMemo(() => data.workOrders.filter((w) => inScope(w.deviceId)), [data.workOrders, inScope]);
  const coverages = useMemo(() => data.coverages.filter((c) => inScope(c.deviceId)), [data.coverages, inScope]);
  const schedules = useMemo(() => data.schedules.filter((s) => inScope(s.deviceId)), [data.schedules, inScope]);

  const visibleOrders = useMemo(() => {
    const now = new Date();
    return workOrders.filter((w) => matchesView(w, view, now) && matchesSearch(w, search));
  }, [workOrders, view, search]);

  const activeByDvir = useMemo(() => {
    const m = new Map<string, number>();
    for (const w of data.workOrders) {
      if (w.source.type !== "dvir" || w.status === "completed" || w.status === "cancelled") continue;
      if (w.source.defectId) m.set(`d:${w.source.defectId}`, w.number);
      if (w.source.refId) m.set(`l:${w.source.refId}`, w.number);
    }
    return m;
  }, [data.workOrders]);
  const activeByFault = useMemo(() => {
    const m = new Map<string, number>();
    for (const w of data.workOrders) {
      if (w.source.type !== "fault" || w.status === "completed" || w.status === "cancelled") continue;
      if (w.source.diagnosticId) m.set(`${w.deviceId}|${w.source.diagnosticId}`, w.number);
    }
    return m;
  }, [data.workOrders]);
  const dvirRows = useMemo(
    () => (dvir ? dvir.filter((d) => inScope(d.deviceId)).map((d) => ({ ...d, openWorkOrderNumber: activeByDvir.get(`d:${d.defectId}`) ?? activeByDvir.get(`l:${d.logId}`) ?? null })) : null),
    [dvir, inScope, activeByDvir]
  );
  const faultRows = useMemo(
    () => (faults ? faults.filter((f) => inScope(f.deviceId)).map((f) => ({ ...f, openWorkOrderNumber: activeByFault.get(`${f.deviceId}|${f.diagnosticId}`) ?? null })) : null),
    [faults, inScope, activeByFault]
  );
  const dueRows = useMemo(() => evaluateAll(schedules, snapshots, data.workOrders, settings).filter((r) => r.evaluation.state === "overdue" || r.evaluation.state === "due_soon"), [schedules, snapshots, data.workOrders, settings]);

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
        await readSnapshots(schedules.map((s) => s.deviceId), "Refreshing readings");
      }
    } catch (e) {
      setIntakeError(friendlyError(e));
    } finally {
      setIntakeLoading(false);
      setProgress(null);
    }
  }, [insideMyGeotab, api, attentionView, groupIds, settings.dvirLookbackDays, settings.faultLookbackDays, groupsById, devicesById, usersById, readSnapshots, schedules]);

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
      if (have) return have;
      try {
        const got = await readSnapshots([deviceId], "Reading vehicle");
        return got.get(deviceId);
      } catch (e) {
        setNotice(`Couldn't read odometer / engine hours for this vehicle: ${friendlyError(e)}`);
        return undefined;
      } finally {
        setProgress(null);
      }
    },
    [snapshots, readSnapshots]
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

  const openWorkOrderByNumber = useCallback(
    (n: number) => {
      const wo = data.workOrders.find((w) => w.number === n);
      if (wo) {
        setEditor({ kind: "wo", draft: wo, isNew: false });
      }
    },
    [data.workOrders]
  );

  const runSave = useCallback(async (fn: () => Promise<void>, ok: string) => {
    setSaving(true);
    setNotice(null);
    try {
      await fn();
      setNotice(ok);
    } catch (e) {
      setNotice(`Save failed: ${friendlyError(e)}`);
    } finally {
      setSaving(false);
    }
  }, []);

  const saveWorkOrder = useCallback(async () => {
    if (!editor || editor.kind !== "wo" || !storeRef.current) return;
    const store = storeRef.current;
    const now = new Date().toISOString();
    let wo: WorkOrder = { ...editor.draft, title: editor.draft.title.trim(), updatedAt: now, updatedBy: currentUser };
    if (!wo.id) {
      // Re-check the number against the latest list in case another user added one meanwhile.
      const taken = new Set(data.workOrders.map((w) => w.number));
      while (taken.has(wo.number)) wo = { ...wo, number: wo.number + 1 };
    }
    await runSave(async () => {
      const saved = await store.saveWorkOrder(wo);
      let scheduleUpdate: ServiceSchedule | null = null;
      if (saved.status === "completed" && saved.source.type === "schedule" && saved.source.refId) {
        const s = data.schedules.find((x) => x.id === saved.source.refId);
        const before = data.workOrders.find((x) => x.id === saved.id);
        if (s && before?.status !== "completed") scheduleUpdate = await store.saveSchedule(rollSchedule(s, saved));
      }
      setData((d) => ({
        ...d,
        workOrders: [saved, ...d.workOrders.filter((w) => w.id !== saved.id)].sort((a, b) => b.number - a.number),
        schedules: scheduleUpdate ? d.schedules.map((s) => (s.id === scheduleUpdate!.id ? scheduleUpdate! : s)) : d.schedules,
      }));
      setEditor(null);
    }, `Saved WO-${String(wo.number).padStart(5, "0")}.`);
  }, [editor, currentUser, data.workOrders, data.schedules, runSave]);

  const deleteWorkOrder = useCallback(async () => {
    if (!editor || editor.kind !== "wo" || !editor.draft.id || !storeRef.current) return;
    const id = editor.draft.id;
    await runSave(async () => {
      await storeRef.current!.deleteWorkOrder(id);
      setData((d) => ({ ...d, workOrders: d.workOrders.filter((w) => w.id !== id) }));
      setEditor(null);
    }, "Work order deleted.");
  }, [editor, runSave]);

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

  const newSchedule = useCallback(
    (deviceId = "") => {
      const device = devicesById.get(deviceId);
      const now = new Date().toISOString();
      setEditor({
        kind: "schedule",
        isNew: true,
        draft: {
          deviceId,
          deviceName: device?.name ?? "",
          name: "",
          category: "preventive",
          intervalMeters: null,
          intervalEngineSeconds: null,
          intervalDays: null,
          lastDoneAt: null,
          lastDoneMeters: null,
          lastDoneEngineSeconds: null,
          notes: "",
          createdAt: now,
          updatedAt: now,
        },
      });
    },
    [devicesById]
  );

  const changeEditorVehicle = useCallback(
    async (deviceId: string) => {
      const device = devicesById.get(deviceId);
      if (!device) return;
      await ensureSnapshot(deviceId);
      setEditor((ed) => (ed && ed.kind !== "wo" ? ({ ...ed, draft: { ...ed.draft, deviceId, deviceName: device.name ?? deviceId } } as Editor) : ed));
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
    }, "Coverage saved.");
  }, [editor, runSave]);

  const deleteCoverage = useCallback(async () => {
    if (!editor || editor.kind !== "coverage" || !editor.draft.id) return;
    const id = editor.draft.id;
    await runSave(async () => {
      await storeRef.current!.deleteCoverage(id);
      setData((d) => ({ ...d, coverages: d.coverages.filter((x) => x.id !== id) }));
      setEditor(null);
    }, "Coverage deleted.");
  }, [editor, runSave]);

  const saveSchedule = useCallback(async () => {
    if (!editor || editor.kind !== "schedule" || !storeRef.current) return;
    const s = { ...editor.draft, name: editor.draft.name.trim(), updatedAt: new Date().toISOString() };
    await runSave(async () => {
      const saved = await storeRef.current!.saveSchedule(s);
      setData((d) => ({ ...d, schedules: [...d.schedules.filter((x) => x.id !== saved.id), saved] }));
      setEditor(null);
    }, "Schedule saved.");
  }, [editor, runSave]);

  const deleteSchedule = useCallback(async () => {
    if (!editor || editor.kind !== "schedule" || !editor.draft.id) return;
    const id = editor.draft.id;
    await runSave(async () => {
      await storeRef.current!.deleteSchedule(id);
      setData((d) => ({ ...d, schedules: d.schedules.filter((x) => x.id !== id) }));
      setEditor(null);
    }, "Schedule deleted.");
  }, [editor, runSave]);

  const exportCsv = useCallback(() => {
    downloadText(`work-orders-${VIEW_LABEL[view].toLowerCase().replace(/\s+/g, "-")}-${todayIso()}.csv`, workOrdersCsv(visibleOrders, settings));
  }, [visibleOrders, settings, view]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const setSetting = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings((s) => ({ ...s, [k]: v }));

  return (
    <div className="mwo-page">
      <div className="mwo-page-header">
        <div>
          <h2>Maintenance Work Orders</h2>
          <p>
            Create and assign work orders from DVIR defects, fault codes, service schedules or by hand; track parts & labor, warranty eligibility and claims.
            {insideMyGeotab ? " Stored in this database's Add-In Data." : " Standalone preview with demo data — nothing is saved."}
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
              <span className="mwo-field-label">Service "due soon" at (% of interval)</span>
              <input className="mwo-input" type="number" min={50} max={100} value={Math.round(settings.dueSoonFraction * 100)} onChange={(e) => setSetting("dueSoonFraction", Math.min(1, Math.max(0.5, (parseInt(e.target.value, 10) || 90) / 100)))} />
            </label>
            <label className="mwo-field">
              <span className="mwo-field-label">API calls per minute (cap)</span>
              <input className="mwo-input" type="number" min={50} max={1000} value={settings.callsPerMinute} onChange={(e) => setSetting("callsPerMinute", Math.min(1000, Math.max(50, parseInt(e.target.value, 10) || 600)))} />
            </label>
          </div>
        </div>
      ) : null}

      <div className="mwo-banners">
        {error ? (
          <Banner type="error" header="Couldn't load">
            {error}
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
        {pendingSnapshots.length ? (
          <Banner
            type="info"
            header={`${pendingSnapshots.length.toLocaleString()} vehicles have warranties or schedules — readings not loaded automatically`}
            action={{
              text: "Read odometer & engine hours now",
              onClick: () => {
                const ids = pendingSnapshots;
                setPendingSnapshots([]);
                void readSnapshots(ids).catch((e) => setNotice(friendlyError(e))).finally(() => setProgress(null));
              },
            }}
          >
            That's {pendingSnapshots.length * 2} API calls — about {Math.ceil((pendingSnapshots.length * 2) / settings.callsPerMinute)} min at the current cap. Warranty and schedule status show as Unknown until then.
          </Banner>
        ) : null}
      </div>

      <div className="mwo-tabs-scroll">
      <Tabs
        tabs={[
          { id: "orders", name: "Work orders", quantity: workOrders.filter((w) => w.status !== "completed" && w.status !== "cancelled").length },
          { id: "attention", name: "Needs attention", quantity: (dvirRows?.filter((d) => d.openWorkOrderNumber == null).length ?? 0) + (faultRows?.filter((f) => f.openWorkOrderNumber == null).length ?? 0) + dueRows.filter((d) => d.evaluation.openWorkOrderNumber == null).length },
          { id: "warranty", name: "Warranty", quantity: coverages.length },
          { id: "schedules", name: "Service schedules", quantity: schedules.length },
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
            <WorkOrderTable rows={visibleOrders} settings={settings} session={session} busy={loading} onOpen={(wo) => setEditor({ kind: "wo", draft: wo, isNew: false })} />
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
            onOpenWorkOrder={openWorkOrderByNumber}
            onCreateFromDvir={(item) => void startWorkOrder(item.deviceId, (wo) => fromDvirDefect(wo, item))}
            onCreateFromFault={(item) => void startWorkOrder(item.deviceId, (wo) => fromFault(wo, item))}
            onCreateFromSchedule={(s) => void startWorkOrder(s.deviceId, (wo) => fromSchedule(wo, s))}
            workOrders={data.workOrders}
          />
        ) : null}

        {tab === "warranty" ? (
          <WarrantyTab coverages={coverages} workOrders={data.workOrders} snapshots={snapshots} devices={scopedDevices} settings={settings} session={session} busy={loading} onNew={() => newCoverage()} onEdit={(c) => setEditor({ kind: "coverage", draft: c, isNew: false })} onOpenWorkOrder={openWorkOrderByNumber} />
        ) : null}

        {tab === "schedules" ? (
          <SchedulesTab schedules={schedules} workOrders={data.workOrders} snapshots={snapshots} settings={settings} session={session} busy={loading} onNew={() => newSchedule()} onEdit={(s) => setEditor({ kind: "schedule", draft: s, isNew: false })} onCreateWorkOrder={(s) => void startWorkOrder(s.deviceId, (wo) => fromSchedule(wo, s))} />
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
          <CoveragePanel draft={editor.draft} isNew={editor.isNew} saving={saving} devices={scopedDevices.length ? scopedDevices : devices} snapshots={snapshots} settings={settings} onChange={(next) => setEditor((ed) => (ed && ed.kind === "coverage" ? { ...ed, draft: next } : ed))} onChangeVehicle={(id) => void changeEditorVehicle(id)} onSave={() => void saveCoverage()} onDelete={() => void deleteCoverage()} onClose={() => setEditor(null)} />
        </ErrorBoundary>
      ) : null}
      {editor?.kind === "schedule" ? (
        <ErrorBoundary label="schedule editor">
          <SchedulePanel draft={editor.draft} isNew={editor.isNew} saving={saving} devices={scopedDevices.length ? scopedDevices : devices} snapshots={snapshots} settings={settings} onChange={(next) => setEditor((ed) => (ed && ed.kind === "schedule" ? { ...ed, draft: next } : ed))} onChangeVehicle={(id) => void changeEditorVehicle(id)} onSave={() => void saveSchedule()} onDelete={() => void deleteSchedule()} onClose={() => setEditor(null)} />
        </ErrorBoundary>
      ) : null}
    </div>
  );
}
