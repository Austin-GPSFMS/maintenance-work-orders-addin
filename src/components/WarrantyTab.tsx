/**
 * Warranty coverages: one row per coverage with its evaluated state against
 * the vehicle's current odometer / engine hours, plus the add / edit panel.
 */

import { useMemo, useState } from "react";
import { Button, SearchInput, SidePanel, SidePanelCloseReason } from "@geotab/zenith";
import type { CoverageEvaluation, CoverageType, GeotabDevice, GeotabSession, Settings, VehicleSnapshot, WarrantyCoverage, WorkOrder } from "../types";
import { formatDate, formatDistance, formatHours, metersToUnit, toDateInputValue, unitToMeters } from "../utils/format";
import { COVERAGE_TYPE_LABEL, evaluateCoverage } from "../utils/warranty";
import { formatNumber, totals } from "../utils/workorders";
import { DateField, NumberField, SelectField, TextAreaField, TextField } from "./fields";
import { VehiclePicker } from "./VehiclePicker";
import { panelWidth, useViewport } from "../utils/viewport";
import { vehicleLink } from "./WorkOrderTable";
import { formatMoney } from "../utils/format";

interface Props {
  coverages: WarrantyCoverage[];
  workOrders: WorkOrder[];
  snapshots: Map<string, VehicleSnapshot>;
  devices: GeotabDevice[];
  settings: Settings;
  session: GeotabSession | null;
  busy: boolean;
  onNew: () => void;
  onEdit: (c: WarrantyCoverage) => void;
  onOpenWorkOrder: (n: number) => void;
}

export function CoveragePill({ state }: { state: CoverageEvaluation["state"] }) {
  switch (state) {
    case "active":
      return <span className="mwo-pill mwo-pill-ok">Active</span>;
    case "expiring":
      return <span className="mwo-pill mwo-pill-info">Expiring</span>;
    case "expired":
      return <span className="mwo-pill mwo-pill-warn">Expired</span>;
    case "not_started":
      return <span className="mwo-pill mwo-pill-purple">Not started</span>;
    default:
      return <span className="mwo-pill mwo-pill-muted">Unknown</span>;
  }
}

type View = "all" | "active" | "expiring" | "expired";

export function WarrantyTab({ coverages, workOrders, snapshots, settings, session, busy, onNew, onEdit, onOpenWorkOrder }: Props) {
  const [view, setView] = useState<View>("all");
  const [q, setQ] = useState("");
  const now = new Date();
  const rows = useMemo(
    () =>
      coverages
        .map((c) => ({ c, ev: evaluateCoverage(c, snapshots.get(c.deviceId), settings, now) }))
        .filter((r) => (view === "all" ? true : view === "active" ? r.ev.state === "active" || r.ev.state === "not_started" : r.ev.state === view))
        .filter((r) => !q || `${r.c.deviceName} ${r.c.provider} ${r.c.policyNumber} ${r.c.components} ${COVERAGE_TYPE_LABEL[r.c.type]}`.toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => a.c.deviceName.localeCompare(b.c.deviceName, undefined, { numeric: true }) || a.c.startDate.localeCompare(b.c.startDate)),
    [coverages, snapshots, settings, view, q] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const claimsFor = (c: WarrantyCoverage) => workOrders.filter((w) => w.warranty.isWarrantyWork && w.warranty.coverageId === c.id);
  const counts = (s: View) => coverages.filter((c) => s === "all" || evaluateCoverage(c, snapshots.get(c.deviceId), settings, now).state === s).length;

  return (
    <div className="mwo-card">
      <div className="mwo-card-head">
        <h3>Warranty coverage</h3>
        <div className="mwo-actions">
          {(["all", "active", "expiring", "expired"] as View[]).map((v) => (
            <Button key={v} type={view === v ? "primary" : "tertiary"} onClick={() => setView(v)}>
              {v[0].toUpperCase() + v.slice(1)} ({counts(v)})
            </Button>
          ))}
          <SearchInput value={q} onChange={(v) => setQ(v)} placeholder="Search vehicle, provider, policy…" onClear={() => setQ("")} />
          <Button type="primary" onClick={onNew}>
            + Add coverage
          </Button>
        </div>
      </div>
      <p className="mwo-muted mwo-small" style={{ marginTop: 0 }}>
        A work order on a vehicle with an <b>Active</b> or <b>Expiring</b> coverage is flagged warranty-eligible automatically. Distance and hour limits are checked against the vehicle's latest adjusted odometer / engine hours from MyGeotab.
      </p>
      {rows.length === 0 ? (
        <div className="mwo-empty">{coverages.length ? "No coverages match." : "No warranty coverage recorded yet. Add one per vehicle (or per component) and the add-in will do the eligibility maths."}</div>
      ) : (
        <div className={`mwo-table-wrap ${busy ? "mwo-busy" : ""}`}>
          <table className="mwo-table">
            <thead>
              <tr>
                <th>Vehicle</th>
                <th>Coverage</th>
                <th>Status</th>
                <th>Ends</th>
                <th>Distance left</th>
                <th>Hours left</th>
                <th>Claims</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ c, ev }) => {
                const link = vehicleLink(session, c.deviceId);
                const claims = claimsFor(c);
                const recovered = claims.reduce((s, w) => s + (w.warranty.claim.amountRecovered ?? 0), 0);
                return (
                  <tr key={c.id} className="mwo-row" onClick={() => onEdit(c)}>
                    <td className="mwo-asset">
                      {link ? (
                        <a href={link} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                          {c.deviceName}
                        </a>
                      ) : (
                        c.deviceName
                      )}
                    </td>
                    <td>
                      <span className="mwo-title">{COVERAGE_TYPE_LABEL[c.type]}</span>
                      <span className="mwo-title-sub">{[c.provider, c.policyNumber ? `#${c.policyNumber}` : "", c.components].filter(Boolean).join(" · ")}</span>
                    </td>
                    <td title={ev.reasons.join("\n")}>
                      <CoveragePill state={ev.state} />
                    </td>
                    <td className="mwo-nowrap">
                      {ev.endsOn ? formatDate(ev.endsOn) : <span className="mwo-muted">—</span>}
                      {ev.daysLeft != null && ev.daysLeft >= 0 ? <span className="mwo-title-sub">{ev.daysLeft} days</span> : null}
                    </td>
                    <td className="mwo-num">{ev.metersLeft != null ? formatDistance(ev.metersLeft, settings.units) : c.limitMeters != null ? <span className="mwo-muted" title="No odometer reading">?</span> : <span className="mwo-muted">unlimited</span>}</td>
                    <td className="mwo-num">{ev.engineSecondsLeft != null ? formatHours(ev.engineSecondsLeft) : c.limitEngineSeconds != null ? <span className="mwo-muted">?</span> : <span className="mwo-muted">—</span>}</td>
                    <td>
                      {claims.length ? (
                        <span>
                          {claims.map((w) => (
                            <button key={w.id} className="mwo-link" style={{ marginRight: 6 }} onClick={(e) => { e.stopPropagation(); onOpenWorkOrder(w.number); }} title={`${w.title} — ${formatMoney(totals(w).warranty, settings.currency)} warranty`}>
                              {formatNumber(w.number)}
                            </button>
                          ))}
                          {recovered ? <span className="mwo-title-sub">{formatMoney(recovered, settings.currency)} recovered</span> : null}
                        </span>
                      ) : (
                        <span className="mwo-muted">—</span>
                      )}
                    </td>
                    <td className="mwo-cell-actions">
                      <Button type="tertiary" onClick={() => onEdit(c)}>
                        Edit
                      </Button>
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
// Coverage editor
// ---------------------------------------------------------------------------

const TYPE_OPTIONS = (Object.keys(COVERAGE_TYPE_LABEL) as CoverageType[]).map((id) => ({ id, name: COVERAGE_TYPE_LABEL[id] }));

interface PanelProps {
  draft: WarrantyCoverage;
  isNew: boolean;
  saving: boolean;
  devices: GeotabDevice[];
  snapshots: Map<string, VehicleSnapshot>;
  settings: Settings;
  onChange: (c: WarrantyCoverage) => void;
  onChangeVehicle: (deviceId: string) => void;
  onSave: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function CoveragePanel({ draft: c, isNew, saving, devices, snapshots, settings, onChange, onChangeVehicle, onSave, onDelete, onClose }: PanelProps) {
  const vp = useViewport();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = <K extends keyof WarrantyCoverage>(k: K, v: WarrantyCoverage[K]) => onChange({ ...c, [k]: v });
  const snap = snapshots.get(c.deviceId);
  const ev = c.deviceId && c.startDate ? evaluateCoverage(c, snap, settings) : null;
  const u = settings.units;
  const canSave = !!c.deviceId && !!c.startDate && !saving;

  return (
    <SidePanel className="mwo-side-panel" isOpen label={isNew ? "Add warranty coverage" : "Edit warranty coverage"} width={panelWidth(vp, 640)} onHidePanel={(r) => r === SidePanelCloseReason.Escape && onClose()}>
      <SidePanel.Cell title={isNew ? "Add warranty coverage" : `${c.deviceName} — ${COVERAGE_TYPE_LABEL[c.type]}`}>
        <div className="mwo-panel">
          <div className="mwo-form-grid">
            <div className="mwo-span-2">
              <VehiclePicker devices={devices} value={c.deviceId || null} onChange={(id) => id && onChangeVehicle(id)} />
              {snap ? (
                <span className="mwo-muted mwo-small">
                  Now: {formatDistance(snap.odometerMeters, u)} · {formatHours(snap.engineSeconds)}
                </span>
              ) : null}
            </div>
            <SelectField label="Coverage type" value={c.type} options={TYPE_OPTIONS} onChange={(v) => set("type", v)} />
            <TextField label="Provider" value={c.provider} onChange={(v) => set("provider", v)} placeholder="Peterbilt, Cummins, Heil, dealer…" />
            <TextField label="Policy / contract #" value={c.policyNumber} onChange={(v) => set("policyNumber", v)} />
            <TextField label="What's covered" value={c.components} onChange={(v) => set("components", v)} placeholder="Bumper to bumper · engine + aftertreatment · body" />
            <DateField label="Start date" value={toDateInputValue(c.startDate)} onChange={(v) => set("startDate", v ?? "")} hint="In-service / purchase date" />
            <NumberField label="Term (months)" value={c.months} onChange={(v) => set("months", v)} hint={c.endDate ? "Ignored while an end date is set" : "Leave blank with no end date for open-ended"} />
            <DateField label="End date (optional)" value={toDateInputValue(c.endDate)} onChange={(v) => set("endDate", v)} hint="Overrides the term" />
            <NumberField label={`Odometer at start (${u})`} value={c.startMeters == null ? null : Math.round(metersToUnit(c.startMeters, u))} onChange={(v) => set("startMeters", v == null ? null : unitToMeters(v, u))} hint="Blank = 0" />
            <NumberField label={`Distance limit (${u})`} value={c.limitMeters == null ? null : Math.round(metersToUnit(c.limitMeters, u))} onChange={(v) => set("limitMeters", v == null ? null : unitToMeters(v, u))} hint="Blank = unlimited" />
            <NumberField label="Engine hours at start" value={c.startEngineSeconds == null ? null : Math.round(c.startEngineSeconds / 3600)} onChange={(v) => set("startEngineSeconds", v == null ? null : v * 3600)} />
            <NumberField label="Engine-hours limit" value={c.limitEngineSeconds == null ? null : Math.round(c.limitEngineSeconds / 3600)} onChange={(v) => set("limitEngineSeconds", v == null ? null : v * 3600)} hint="Blank = no hours limit" />
            <TextAreaField className="mwo-span-2" label="Notes" value={c.notes} onChange={(v) => set("notes", v)} rows={2} placeholder="Deductible, claim contact, exclusions…" />
          </div>
          {ev ? (
            <div className="mwo-panel-section">
              <div className="mwo-panel-section-head">
                <h4>Evaluation today</h4>
                <CoveragePill state={ev.state} />
              </div>
              <ul className="mwo-reasons">
                {ev.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
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
                {saving ? "Saving…" : isNew ? "Add coverage" : "Save changes"}
              </Button>
            </div>
          </div>
        </div>
      </SidePanel.Cell>
    </SidePanel>
  );
}
