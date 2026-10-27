/**
 * Create / edit a work order in a Zenith SidePanel.
 *
 * The draft lives in App (so a vehicle change can fetch that vehicle's
 * odometer / engine hours and re-run warranty eligibility); this component
 * only edits it and asks App to save / delete / close.
 */

import { useMemo, useState } from "react";
import { Banner, Button, Checkbox, SidePanel, SidePanelCloseReason } from "@geotab/zenith";
import type {
  ClaimStatus,
  GeotabDevice,
  GeotabSession,
  GeotabUser,
  LineItem,
  LineType,
  Settings,
  VehicleSnapshot,
  WarrantyCoverage,
  WorkOrder,
  WorkOrderCategory,
  WorkOrderPriority,
  WorkOrderStatus,
} from "../types";
import { userLabel } from "../api/geotab";
import { formatDateTime, formatDistance, formatHours, formatMoney, toDateInputValue } from "../utils/format";
import { activeCoverages, coverageLabel } from "../utils/warranty";
import {
  CATEGORY_LABEL,
  CLAIM_ORDER,
  CLAIM_STATUS_LABEL,
  LINE_TYPE_LABEL,
  PRIORITY_LABEL,
  STATUS_LABEL,
  formatNumber,
  lineTotal,
  newLine,
  totals,
  transition,
} from "../utils/workorders";
import { DateField, NumberField, SelectField, TextAreaField, TextField } from "./fields";
import { VehiclePicker } from "./VehiclePicker";
import { panelWidth, useViewport } from "../utils/viewport";
import { vehicleLink } from "./WorkOrderTable";

interface Props {
  draft: WorkOrder | null;
  isNew: boolean;
  saving: boolean;
  devices: GeotabDevice[];
  users: GeotabUser[];
  coverages: WarrantyCoverage[];
  snapshots: Map<string, VehicleSnapshot>;
  settings: Settings;
  currentUser: string;
  session: GeotabSession | null;
  onChange: (next: WorkOrder) => void;
  onChangeVehicle: (deviceId: string) => void;
  onSave: () => void;
  onDelete: () => void;
  onClose: () => void;
}

const PRIORITY_OPTIONS = (Object.keys(PRIORITY_LABEL) as WorkOrderPriority[]).map((id) => ({ id, name: PRIORITY_LABEL[id] }));
const CATEGORY_OPTIONS = (Object.keys(CATEGORY_LABEL) as WorkOrderCategory[]).map((id) => ({ id, name: CATEGORY_LABEL[id] }));
const LINE_OPTIONS = (Object.keys(LINE_TYPE_LABEL) as LineType[]).map((id) => ({ id, name: LINE_TYPE_LABEL[id] }));
const CLAIM_OPTIONS = CLAIM_ORDER.map((id) => ({ id, name: CLAIM_STATUS_LABEL[id] }));

export function WorkOrderPanel(props: Props) {
  const { draft, isNew, saving, devices, users, coverages, snapshots, settings, currentUser, session, onChange, onChangeVehicle, onSave, onDelete, onClose } = props;
  const vp = useViewport();
  const [note, setNote] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const snap = draft ? snapshots.get(draft.deviceId) : undefined;
  const coverageChoices = useMemo(() => {
    if (!draft) return [];
    return activeCoverages(draft.deviceId, coverages, snap, settings).map((x) => ({ id: x.coverage.id ?? "", name: coverageLabel(x.coverage) }));
  }, [draft, coverages, snap, settings]);

  const assigneeOptions = useMemo(() => [{ id: "__none", name: "Unassigned" }, ...users.map((u) => ({ id: u.id, name: userLabel(u) }))], [users]);

  if (!draft) return null;
  const wo = draft;
  const set = <K extends keyof WorkOrder>(k: K, v: WorkOrder[K]) => onChange({ ...wo, [k]: v });
  const setWarranty = (patch: Partial<WorkOrder["warranty"]>) => onChange({ ...wo, warranty: { ...wo.warranty, ...patch } });
  const setClaim = (patch: Partial<WorkOrder["warranty"]["claim"]>) => setWarranty({ claim: { ...wo.warranty.claim, ...patch } });
  const setLine = (id: string, patch: Partial<LineItem>) => set("lines", wo.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const t = totals(wo);
  const canSave = !!wo.deviceId && wo.title.trim().length > 0 && !saving;
  const link = vehicleLink(session, wo.deviceId);
  const done = wo.status === "completed" || wo.status === "cancelled";

  const statusButton = (status: WorkOrderStatus, label: string, type: "primary" | "secondary" | "tertiary" | "destructive" = "secondary") => (
    <Button key={status} type={type} disabled={saving} onClick={() => onChange(transition(wo, status, currentUser, snap))}>
      {label}
    </Button>
  );

  const addNote = () => {
    const text = note.trim();
    if (!text) return;
    set("activity", [...wo.activity, { at: new Date().toISOString(), by: currentUser, text }]);
    setNote("");
  };

  return (
    <SidePanel
      className="mwo-side-panel"
      isOpen
      label={isNew ? "New work order" : `${formatNumber(wo.number)} — ${wo.title || "Work order"}`}
      width={panelWidth(vp, 840)}
      onHidePanel={(reason) => {
        if (reason === SidePanelCloseReason.Escape) onClose();
      }}
    >
      <SidePanel.Cell title={isNew ? "New work order" : `${formatNumber(wo.number)} · ${STATUS_LABEL[wo.status]}`}>
        <div className="mwo-panel">
          {/* ---- Status workflow ---- */}
          {!isNew ? (
            <div className="mwo-status-bar">
              <span className="mwo-muted">Status:</span>
              {wo.status === "open" ? statusButton("in_progress", "Start work", "primary") : null}
              {wo.status === "in_progress" ? statusButton("completed", "Complete", "primary") : null}
              {wo.status === "in_progress" ? statusButton("on_hold", "Put on hold") : null}
              {wo.status === "on_hold" ? statusButton("in_progress", "Resume", "primary") : null}
              {wo.status === "open" ? statusButton("completed", "Complete") : null}
              {!done ? statusButton("cancelled", "Cancel order", "tertiary") : null}
              {done ? statusButton("open", "Reopen") : null}
            </div>
          ) : null}

          {/* ---- Vehicle + job ---- */}
          <div className="mwo-form-grid">
            <div className="mwo-span-2">
              <VehiclePicker devices={devices} value={wo.deviceId || null} disabled={!isNew} onChange={(id) => id && onChangeVehicle(id)} />
              {wo.deviceId ? (
                <div className="mwo-muted mwo-small" style={{ marginTop: 4 }}>
                  {snap?.odometerMeters != null ? `Odometer ${formatDistance(snap.odometerMeters, settings.units)}` : "No odometer reading"}
                  {snap?.engineSeconds != null ? ` · ${formatHours(snap.engineSeconds)}` : ""}
                  {wo.odometerAtOpen != null ? ` · at open ${formatDistance(wo.odometerAtOpen, settings.units)}` : ""}
                  {wo.odometerAtClose != null ? ` · at close ${formatDistance(wo.odometerAtClose, settings.units)}` : ""}
                  {link ? (
                    <>
                      {" · "}
                      <a href={link} target="_blank" rel="noreferrer">
                        Open vehicle
                      </a>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
            <TextField className="mwo-span-2" label="Work to do" value={wo.title} onChange={(v) => set("title", v)} placeholder="e.g. Replace LR brake chamber" />
            <TextAreaField className="mwo-span-2" label="Details" value={wo.description} onChange={(v) => set("description", v)} rows={3} />
            <SelectField label="Priority" value={wo.priority} options={PRIORITY_OPTIONS} onChange={(v) => set("priority", v)} />
            <SelectField label="Category" value={wo.category} options={CATEGORY_OPTIONS} onChange={(v) => set("category", v)} />
            <SelectField
              label="Assign to"
              value={wo.assigneeId ?? "__none"}
              options={assigneeOptions}
              onChange={(id) => {
                const u = users.find((x) => x.id === id);
                onChange({ ...wo, assigneeId: u ? u.id : null, assigneeName: u ? userLabel(u) : "" });
              }}
            />
            <DateField label="Due date" value={toDateInputValue(wo.dueDate)} onChange={(v) => set("dueDate", v)} />
            <TextField label="Vendor / shop" value={wo.vendor} onChange={(v) => set("vendor", v)} placeholder="Blank when done in-house" />
            <TextField label="Invoice / RO #" value={wo.invoiceNumber} onChange={(v) => set("invoiceNumber", v)} />
          </div>

          {wo.source.type !== "manual" ? (
            <Banner type="info" header="Source">
              {wo.source.label}
            </Banner>
          ) : null}

          {/* ---- Line items ---- */}
          <div className="mwo-panel-section">
            <div className="mwo-panel-section-head">
              <h4>Parts & labor</h4>
              <div className="mwo-actions">
                <Button type="tertiary" onClick={() => set("lines", [...wo.lines, newLine("labor", "", wo.warranty.isWarrantyWork)])}>
                  + Labor
                </Button>
                <Button type="tertiary" onClick={() => set("lines", [...wo.lines, newLine("part", "", wo.warranty.isWarrantyWork)])}>
                  + Part
                </Button>
                <Button type="tertiary" onClick={() => set("lines", [...wo.lines, newLine("service", "", wo.warranty.isWarrantyWork)])}>
                  + Outside service
                </Button>
              </div>
            </div>
            {wo.lines.length ? (
              <table className="mwo-lines">
                <colgroup>
                  <col style={{ width: 104 }} />
                  <col />
                  <col style={{ width: 56 }} />
                  <col style={{ width: 84 }} />
                  <col style={{ width: 80 }} />
                  <col style={{ width: 66 }} />
                  <col style={{ width: 24 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Description</th>
                    <th>Qty</th>
                    <th>Unit cost</th>
                    <th className="mwo-num">Total</th>
                    <th title="Billed to the warranty provider">Warranty</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {wo.lines.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <select className="mwo-input mwo-input-sm" value={l.type} onChange={(e) => setLine(l.id, { type: e.target.value as LineType, unitCost: e.target.value === "labor" && !l.unitCost ? settings.laborRate : l.unitCost })}>
                          {LINE_OPTIONS.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input className="mwo-input mwo-input-sm" value={l.description} placeholder={l.type === "labor" ? "Hours of labor" : "Part number / description"} onChange={(e) => setLine(l.id, { description: e.target.value })} />
                      </td>
                      <td>
                        <input className="mwo-input mwo-input-sm" type="number" step="any" min={0} value={l.qty} onChange={(e) => setLine(l.id, { qty: parseFloat(e.target.value) || 0 })} />
                      </td>
                      <td>
                        <input className="mwo-input mwo-input-sm" type="number" step="any" min={0} value={l.unitCost} onChange={(e) => setLine(l.id, { unitCost: parseFloat(e.target.value) || 0 })} />
                      </td>
                      <td className="mwo-num">{formatMoney(lineTotal(l), settings.currency)}</td>
                      <td style={{ textAlign: "center" }}>
                        <input type="checkbox" checked={l.warranty} onChange={(e) => setLine(l.id, { warranty: e.target.checked })} aria-label="Covered by warranty" />
                      </td>
                      <td>
                        <button className="mwo-link" title="Remove line" onClick={() => set("lines", wo.lines.filter((x) => x.id !== l.id))}>
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <span className="mwo-muted mwo-small">No lines yet — add labor (hours × rate, default {formatMoney(settings.laborRate, settings.currency)}/h), parts or outside services.</span>
            )}
            <div className="mwo-totals">
              <span>
                Warranty: <b>{formatMoney(t.warranty, settings.currency)}</b>
              </span>
              <span>
                Fleet: <b>{formatMoney(t.fleet, settings.currency)}</b>
              </span>
              <span>
                Total: <b>{formatMoney(t.total, settings.currency)}</b>
              </span>
            </div>
          </div>

          {/* ---- Warranty ---- */}
          <div className="mwo-panel-section">
            <div className="mwo-panel-section-head">
              <h4>Warranty</h4>
              {wo.warranty.eligible ? <span className="mwo-pill mwo-pill-ok">Vehicle in coverage</span> : <span className="mwo-pill mwo-pill-muted">No active coverage on this vehicle</span>}
            </div>
            <Checkbox
              checked={wo.warranty.isWarrantyWork}
              onChange={(e) => {
                const on = e.target.checked;
                onChange({
                  ...wo,
                  warranty: { ...wo.warranty, isWarrantyWork: on, claim: { ...wo.warranty.claim, status: on && wo.warranty.claim.status === "none" ? "pending" : on ? wo.warranty.claim.status : "none" } },
                  lines: wo.lines.map((l) => ({ ...l, warranty: on })),
                });
              }}
            >
              This is warranty work — bill the lines to the provider and track a claim
            </Checkbox>
            {wo.warranty.isWarrantyWork ? (
              <div className="mwo-form-grid">
                {coverageChoices.length ? (
                  <SelectField
                    className="mwo-span-2"
                    label="Claim against coverage"
                    value={wo.warranty.coverageId ?? ""}
                    options={coverageChoices}
                    onChange={(id) => setWarranty({ coverageId: id, coverageLabel: coverageChoices.find((c) => c.id === id)?.name ?? "" })}
                  />
                ) : (
                  <Banner type="warning" header="No active coverage found">
                    {wo.warranty.coverageLabel ? `Recorded coverage: ${wo.warranty.coverageLabel}. ` : ""}
                    Add the vehicle's warranty on the Warranty tab so eligibility is checked automatically, or carry on with a manual claim.
                  </Banner>
                )}
                <SelectField label="Claim status" value={wo.warranty.claim.status} options={CLAIM_OPTIONS.filter((o) => o.id !== "none")} onChange={(v: ClaimStatus) => setClaim({ status: v })} />
                <TextField label="Claim #" value={wo.warranty.claim.claimNumber} onChange={(v) => setClaim({ claimNumber: v })} />
                <DateField label="Submitted" value={toDateInputValue(wo.warranty.claim.submittedAt)} onChange={(v) => setClaim({ submittedAt: v })} />
                <DateField label="Resolved" value={toDateInputValue(wo.warranty.claim.resolvedAt)} onChange={(v) => setClaim({ resolvedAt: v })} />
                <NumberField label={`Amount claimed (${settings.currency})`} value={wo.warranty.claim.amountClaimed} onChange={(v) => setClaim({ amountClaimed: v })} hint={t.warranty ? `Warranty lines total ${formatMoney(t.warranty, settings.currency)}` : undefined} />
                <NumberField label={`Amount recovered (${settings.currency})`} value={wo.warranty.claim.amountRecovered} onChange={(v) => setClaim({ amountRecovered: v })} />
                <TextAreaField className="mwo-span-2" label="Claim notes" value={wo.warranty.claim.notes} onChange={(v) => setClaim({ notes: v })} rows={2} />
              </div>
            ) : null}
          </div>

          {/* ---- Activity ---- */}
          <div className="mwo-panel-section">
            <h4>Activity</h4>
            <ul className="mwo-activity">
              {wo.activity
                .slice()
                .reverse()
                .map((a, i) => (
                  <li key={i}>
                    <time>{formatDateTime(a.at)}</time>
                    <span>
                      <b>{a.by}</b> — {a.text}
                    </span>
                  </li>
                ))}
            </ul>
            <div className="mwo-toolbar">
              <input className="mwo-input mwo-input-sm" style={{ flex: 1 }} placeholder="Add a note…" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addNote()} />
              <Button type="tertiary" onClick={addNote} disabled={!note.trim()}>
                Add note
              </Button>
            </div>
          </div>

          {/* ---- Footer ---- */}
          <div className="mwo-panel-footer">
            <div>
              {!isNew ? (
                confirmDelete ? (
                  <span className="mwo-actions">
                    <span className="mwo-muted mwo-small">Delete {formatNumber(wo.number)}?</span>
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
                {saving ? "Saving…" : isNew ? "Create work order" : "Save changes"}
              </Button>
            </div>
          </div>
        </div>
      </SidePanel.Cell>
    </SidePanel>
  );
}
