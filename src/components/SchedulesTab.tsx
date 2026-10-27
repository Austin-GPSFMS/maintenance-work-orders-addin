/**
 * Service schedules — the add-in's own maintenance reminders (MyGeotab's
 * built-in reminders are not exposed by the API). One row per vehicle +
 * service with its due state against current odometer / hours / date.
 */

import { useMemo, useState } from "react";
import { Button, SearchInput, SidePanel, SidePanelCloseReason } from "@geotab/zenith";
import type { GeotabDevice, GeotabSession, ScheduleEvaluation, ServiceSchedule, Settings, VehicleSnapshot, WorkOrder, WorkOrderCategory } from "../types";
import { formatDate, formatDistance, formatHours, metersToUnit, toDateInputValue, unitToMeters } from "../utils/format";
import { evaluateSchedule } from "../utils/warranty";
import { CATEGORY_LABEL } from "../utils/workorders";
import { DuePill, ProgressMini } from "./AttentionTab";
import { DateField, NumberField, SelectField, TextAreaField, TextField } from "./fields";
import { VehiclePicker } from "./VehiclePicker";
import { panelWidth, useViewport } from "../utils/viewport";
import { vehicleLink } from "./WorkOrderTable";

interface Props {
  schedules: ServiceSchedule[];
  workOrders: WorkOrder[];
  snapshots: Map<string, VehicleSnapshot>;
  settings: Settings;
  session: GeotabSession | null;
  busy: boolean;
  onNew: () => void;
  onEdit: (s: ServiceSchedule) => void;
  onCreateWorkOrder: (s: ServiceSchedule) => void;
}

export function evaluateAll(schedules: ServiceSchedule[], snapshots: Map<string, VehicleSnapshot>, workOrders: WorkOrder[], settings: Settings, now = new Date()) {
  const order: Record<ScheduleEvaluation["state"], number> = { overdue: 0, due_soon: 1, unknown: 2, ok: 3 };
  return schedules
    .map((schedule) => ({ schedule, evaluation: evaluateSchedule(schedule, snapshots.get(schedule.deviceId), workOrders, settings, now) }))
    .sort((a, b) => order[a.evaluation.state] - order[b.evaluation.state] || (b.evaluation.progress ?? 0) - (a.evaluation.progress ?? 0));
}

export function SchedulesTab({ schedules, workOrders, snapshots, settings, session, busy, onNew, onEdit, onCreateWorkOrder }: Props) {
  const [q, setQ] = useState("");
  const rows = useMemo(() => evaluateAll(schedules, snapshots, workOrders, settings).filter((r) => !q || `${r.schedule.deviceName} ${r.schedule.name}`.toLowerCase().includes(q.toLowerCase())), [schedules, snapshots, workOrders, settings, q]);
  const u = settings.units;
  return (
    <div className="mwo-card">
      <div className="mwo-card-head">
        <h3>Service schedules</h3>
        <div className="mwo-actions">
          <SearchInput value={q} onChange={(v) => setQ(v)} placeholder="Search vehicle or service…" onClear={() => setQ("")} />
          <Button type="primary" onClick={onNew}>
            + Add schedule
          </Button>
        </div>
      </div>
      <p className="mwo-muted mwo-small" style={{ marginTop: 0 }}>
        Recurring services by distance, engine hours and/or days. Completing a work order created from a schedule rolls its "last done" forward automatically. Due soon = past {Math.round(settings.dueSoonFraction * 100)}% of the interval.
      </p>
      {rows.length === 0 ? (
        <div className="mwo-empty">{schedules.length ? "No schedules match." : "No service schedules yet."}</div>
      ) : (
        <div className={`mwo-table-wrap ${busy ? "mwo-busy" : ""}`}>
          <table className="mwo-table">
            <thead>
              <tr>
                <th>Vehicle</th>
                <th>Service</th>
                <th>Interval</th>
                <th>Last done</th>
                <th>Status</th>
                <th>Progress</th>
                <th>Why</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ schedule: s, evaluation: ev }) => {
                const link = vehicleLink(session, s.deviceId);
                const interval = [s.intervalMeters != null ? formatDistance(s.intervalMeters, u) : "", s.intervalEngineSeconds != null ? formatHours(s.intervalEngineSeconds) : "", s.intervalDays != null ? `${s.intervalDays} days` : ""].filter(Boolean).join(" / ");
                const last = [s.lastDoneAt ? formatDate(s.lastDoneAt) : "", s.lastDoneMeters != null ? formatDistance(s.lastDoneMeters, u) : "", s.lastDoneEngineSeconds != null ? formatHours(s.lastDoneEngineSeconds) : ""].filter(Boolean).join(" · ");
                return (
                  <tr key={s.id} className={`mwo-row ${ev.state === "overdue" ? "mwo-row-critical" : ev.state === "due_soon" ? "mwo-row-high" : ""}`} onClick={() => onEdit(s)}>
                    <td className="mwo-asset">
                      {link ? (
                        <a href={link} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                          {s.deviceName}
                        </a>
                      ) : (
                        s.deviceName
                      )}
                    </td>
                    <td>
                      <span className="mwo-title">{s.name}</span>
                      <span className="mwo-title-sub">{CATEGORY_LABEL[s.category]}</span>
                    </td>
                    <td className="mwo-nowrap">{interval || <span className="mwo-muted">—</span>}</td>
                    <td className="mwo-nowrap">{last || <span className="mwo-muted">never</span>}</td>
                    <td>
                      <DuePill state={ev.state} />
                    </td>
                    <td>
                      <ProgressMini progress={ev.progress} state={ev.state} />
                    </td>
                    <td>
                      <ul className="mwo-reasons">
                        {ev.reasons.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    </td>
                    <td className="mwo-cell-actions" onClick={(e) => e.stopPropagation()}>
                      {ev.openWorkOrderNumber == null ? (
                        <Button type="tertiary" onClick={() => onCreateWorkOrder(s)}>
                          Create work order
                        </Button>
                      ) : (
                        <span className="mwo-muted mwo-small">WO open</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Schedule editor
// ---------------------------------------------------------------------------

const CATEGORY_OPTIONS = (Object.keys(CATEGORY_LABEL) as WorkOrderCategory[]).map((id) => ({ id, name: CATEGORY_LABEL[id] }));

interface PanelProps {
  draft: ServiceSchedule;
  isNew: boolean;
  saving: boolean;
  devices: GeotabDevice[];
  snapshots: Map<string, VehicleSnapshot>;
  settings: Settings;
  onChange: (s: ServiceSchedule) => void;
  onChangeVehicle: (deviceId: string) => void;
  onSave: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function SchedulePanel({ draft: s, isNew, saving, devices, snapshots, settings, onChange, onChangeVehicle, onSave, onDelete, onClose }: PanelProps) {
  const vp = useViewport();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = <K extends keyof ServiceSchedule>(k: K, v: ServiceSchedule[K]) => onChange({ ...s, [k]: v });
  const snap = snapshots.get(s.deviceId);
  const u = settings.units;
  const canSave = !!s.deviceId && s.name.trim().length > 0 && (s.intervalMeters != null || s.intervalEngineSeconds != null || s.intervalDays != null) && !saving;

  return (
    <SidePanel className="mwo-side-panel" isOpen label={isNew ? "Add service schedule" : "Edit service schedule"} width={panelWidth(vp, 640)} onHidePanel={(r) => r === SidePanelCloseReason.Escape && onClose()}>
      <SidePanel.Cell title={isNew ? "Add service schedule" : `${s.deviceName} — ${s.name}`}>
        <div className="mwo-panel">
          <div className="mwo-form-grid">
            <div className="mwo-span-2">
              <VehiclePicker devices={devices} value={s.deviceId || null} onChange={(id) => id && onChangeVehicle(id)} />
              {snap ? (
                <span className="mwo-muted mwo-small">
                  Now: {formatDistance(snap.odometerMeters, u)} · {formatHours(snap.engineSeconds)}
                </span>
              ) : null}
            </div>
            <TextField label="Service" value={s.name} onChange={(v) => set("name", v)} placeholder="Oil & filter change, DOT inspection, hydraulic service…" />
            <SelectField label="Category" value={s.category} options={CATEGORY_OPTIONS} onChange={(v) => set("category", v)} />
            <NumberField label={`Every (${u})`} value={s.intervalMeters == null ? null : Math.round(metersToUnit(s.intervalMeters, u))} onChange={(v) => set("intervalMeters", v == null ? null : unitToMeters(v, u))} />
            <NumberField label="Every (engine hours)" value={s.intervalEngineSeconds == null ? null : Math.round(s.intervalEngineSeconds / 3600)} onChange={(v) => set("intervalEngineSeconds", v == null ? null : v * 3600)} />
            <NumberField label="Every (days)" value={s.intervalDays} onChange={(v) => set("intervalDays", v)} hint="Whichever comes first" />
            <DateField label="Last done" value={toDateInputValue(s.lastDoneAt)} onChange={(v) => set("lastDoneAt", v)} />
            <NumberField label={`Odometer at last service (${u})`} value={s.lastDoneMeters == null ? null : Math.round(metersToUnit(s.lastDoneMeters, u))} onChange={(v) => set("lastDoneMeters", v == null ? null : unitToMeters(v, u))} hint={snap?.odometerMeters != null ? `Current: ${formatDistance(snap.odometerMeters, u)}` : undefined} />
            <NumberField label="Engine hours at last service" value={s.lastDoneEngineSeconds == null ? null : Math.round(s.lastDoneEngineSeconds / 3600)} onChange={(v) => set("lastDoneEngineSeconds", v == null ? null : v * 3600)} hint={snap?.engineSeconds != null ? `Current: ${formatHours(snap.engineSeconds)}` : undefined} />
            <TextAreaField className="mwo-span-2" label="Notes / checklist" value={s.notes} onChange={(v) => set("notes", v)} rows={3} placeholder="Becomes the work order's details" />
          </div>
          {snap && (s.lastDoneMeters == null || s.lastDoneEngineSeconds == null) ? (
            <div className="mwo-actions">
              <Button type="tertiary" onClick={() => onChange({ ...s, lastDoneAt: s.lastDoneAt ?? new Date().toISOString(), lastDoneMeters: snap.odometerMeters, lastDoneEngineSeconds: snap.engineSeconds })}>
                Use current readings as "last done"
              </Button>
            </div>
          ) : null}
          <div className="mwo-panel-footer">
            <div>
              {!isNew ? (
                confirmDelete ? (
                  <span className="mwo-actions">
                    <Button type="destructive" onClick={onDelete} disabled={saving}>
                      Yes, delete
                    </Button>
                    <Button type="tertiary" onClick={() => setConfirmDelete(false)}>
                      Keep
                    </Button>
                  </span>
                ) : (
                  <Button type="tertiary-destructive" onClick={() => setConfirmDelete(true)} disabled={saving}>
                    Delete
                  </Button>
                )
              ) : null}
            </div>
            <div className="mwo-panel-footer-right">
              <Button type="secondary" onClick={onClose} disabled={saving}>
                Close
              </Button>
              <Button type="primary" onClick={onSave} disabled={!canSave}>
                {saving ? "Saving…" : isNew ? "Add schedule" : "Save changes"}
              </Button>
            </div>
          </div>
        </div>
      </SidePanel.Cell>
    </SidePanel>
  );
}
