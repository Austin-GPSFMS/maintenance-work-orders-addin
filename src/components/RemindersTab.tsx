/**
 * Reminders — MyGeotab's own maintenance reminders (MaintenanceSchedule
 * rules, group-scoped) evaluated per vehicle against the last completed
 * Maintenance Center job and the live odometer / engine hours. Rules are
 * edited in MyGeotab (Maintenance → Reminders); this tab reads them.
 */

import { useMemo, useState } from "react";
import { Banner, Button, SearchInput } from "@geotab/zenith";
import type { GeotabGroup, GeotabSession, ReminderRule, ReminderVehicleRow, Settings } from "../types";
import { formatDate, formatDateTime, formatDistance, formatHours } from "../utils/format";
import { groupNames } from "../utils/groups";
import { formatNumber, woKey } from "../utils/workorders";
import type { WorkOrder } from "../types";
import { DuePill, ProgressMini } from "./AttentionTab";
import { vehicleLink } from "./WorkOrderTable";

interface Props {
  rules: ReminderRule[];
  rows: ReminderVehicleRow[];
  workOrders: WorkOrder[];
  groupsById: Map<string, GeotabGroup>;
  settings: Settings;
  session: GeotabSession | null;
  busy: boolean;
  available: boolean;
  error: string | null;
  readingsPending: number;
  onReadReadings: () => void;
  onCreateWorkOrder: (row: ReminderVehicleRow) => void;
  onOpenWorkOrder: (key: string) => void;
}

type View = "all" | "overdue" | "due_soon" | "ok" | "unknown";

export function intervalLabel(r: ReminderRule, units: Settings["units"]): string {
  const bits = [
    r.intervalMeters != null ? `every ${formatDistance(r.intervalMeters, units)}` : "",
    r.intervalMonths != null ? `every ${r.intervalMonths} mo` : "",
    r.intervalDays != null ? `every ${r.intervalDays} d` : "",
    !r.intervalMeters && !r.intervalMonths && !r.intervalDays && r.eventDate ? `once, ${formatDate(r.eventDate)}` : "",
  ].filter(Boolean);
  return bits.join(" / ") || "no interval";
}

export function RemindersTab({ rules, rows, workOrders, groupsById, settings, session, busy, available, error, readingsPending, onReadReadings, onCreateWorkOrder, onOpenWorkOrder }: Props) {
  const [view, setView] = useState<View>("all");
  const [q, setQ] = useState("");
  const [openRule, setOpenRule] = useState<string | null>(null);

  const byRule = useMemo(() => {
    const m = new Map<string, ReminderVehicleRow[]>();
    for (const r of rows) {
      const list = m.get(r.rule.id);
      if (list) list.push(r);
      else m.set(r.rule.id, [r]);
    }
    return m;
  }, [rows]);

  const counts = (list: ReminderVehicleRow[]) => ({
    overdue: list.filter((r) => r.evaluation.state === "overdue").length,
    due_soon: list.filter((r) => r.evaluation.state === "due_soon").length,
    ok: list.filter((r) => r.evaluation.state === "ok").length,
    unknown: list.filter((r) => r.evaluation.state === "unknown").length,
  });
  const total = counts(rows);
  const visibleRows = (list: ReminderVehicleRow[]) => list.filter((r) => (view === "all" ? true : r.evaluation.state === view)).filter((r) => !q || `${r.deviceName} ${r.rule.name}`.toLowerCase().includes(q.toLowerCase()));

  if (!available) {
    return (
      <div className="mwo-card">
        <h3 style={{ marginTop: 0 }}>Reminders</h3>
        <Banner type="warning" header="MyGeotab reminders unavailable">
          {error ?? "This database did not answer the Maintenance Center calls (MaintenanceSchedule). Reminders are managed in MyGeotab → Maintenance → Reminders; nothing to show here until that works."}
        </Banner>
      </div>
    );
  }

  return (
    <div className="mwo-card">
      <div className="mwo-card-head">
        <h3>Reminders</h3>
        <div className="mwo-actions">
          {(["all", "overdue", "due_soon", "ok", "unknown"] as View[]).map((v) => (
            <Button key={v} type={view === v ? "primary" : "tertiary"} onClick={() => setView(v)}>
              {v === "all" ? `All (${rows.length})` : v === "due_soon" ? `Due soon (${total.due_soon})` : `${v[0].toUpperCase()}${v.slice(1)} (${total[v]})`}
            </Button>
          ))}
          <SearchInput value={q} onChange={(v) => setQ(v)} placeholder="Search vehicle or reminder…" onClear={() => setQ("")} />
        </div>
      </div>
      <p className="mwo-muted mwo-small" style={{ marginTop: 0 }}>
        These are the reminder rules from MyGeotab (Maintenance → Reminders), applied to every vehicle in each rule's groups. "Last done" is the vehicle's last completed Maintenance Center job for that rule; due state compares the interval with the live odometer / hours. Edit the rules in MyGeotab — Geotab's Oil Life / ESR insights are not listed.
      </p>
      {readingsPending > 0 ? (
        <Banner type="info" header={`${readingsPending.toLocaleString()} vehicles with a service on record haven't reported an odometer in the last 14 days`} action={{ text: `Look ${readingsPending > 300 ? "the first 300" : "them"} up`, onClick: onReadReadings }}>
          Their distance-based reminders show as Unknown until their last known odometer is looked up (2 API calls per vehicle).
        </Banner>
      ) : null}
      {rules.length === 0 ? (
        <div className="mwo-empty">No reminder rules in MyGeotab for the selected groups.</div>
      ) : (
        <div className={busy ? "mwo-busy" : ""}>
          {rules.map((rule) => {
            const list = byRule.get(rule.id) ?? [];
            const c = counts(list);
            const shown = visibleRows(list);
            const expanded = openRule === rule.id;
            if (view !== "all" && shown.length === 0) return null;
            return (
              <div key={rule.id} className="mwo-rule">
                <button type="button" className="mwo-rule-head" onClick={() => setOpenRule(expanded ? null : rule.id)} aria-expanded={expanded}>
                  <span className="mwo-rule-chevron">{expanded ? "▾" : "▸"}</span>
                  <span className="mwo-rule-name">{rule.name}</span>
                  <span className="mwo-muted mwo-small">{intervalLabel(rule, settings.units)}</span>
                  <span className="mwo-muted mwo-small">{groupNames(rule.groupIds.map((id) => ({ id })), groupsById) || "Entire organization"}</span>
                  {rule.labels.length ? <span className="mwo-pill mwo-pill-muted">{rule.labels.join(", ")}</span> : null}
                  <span className="mwo-spacer" />
                  <span className="mwo-muted mwo-small">{list.length.toLocaleString()} vehicles</span>
                  {c.overdue ? <span className="mwo-pill mwo-pill-warn">{c.overdue} overdue</span> : null}
                  {c.due_soon ? <span className="mwo-pill mwo-pill-info">{c.due_soon} due soon</span> : null}
                  {c.unknown ? <span className="mwo-pill mwo-pill-muted">{c.unknown} unknown</span> : null}
                  {!rule.active ? <span className="mwo-pill mwo-pill-muted">inactive</span> : null}
                </button>
                {expanded ? (
                  shown.length === 0 ? (
                    <div className="mwo-empty">No vehicles match.</div>
                  ) : (
                    <div className="mwo-table-wrap">
                      <table className="mwo-table">
                        <thead>
                          <tr>
                            <th>Vehicle</th>
                            <th>Status</th>
                            <th>Progress</th>
                            <th>Last done</th>
                            <th>Why</th>
                            <th>Work order</th>
                          </tr>
                        </thead>
                        <tbody>
                          {shown.slice(0, 500).map((r) => {
                            const link = vehicleLink(session, r.deviceId);
                            const open = r.openWorkOrderId ? workOrders.find((w) => woKey(w) === r.openWorkOrderId) : undefined;
                            return (
                              <tr key={r.key} className={r.evaluation.state === "overdue" ? "mwo-row-critical" : r.evaluation.state === "due_soon" ? "mwo-row-high" : ""}>
                                <td className="mwo-asset">{link ? <a href={link} target="_blank" rel="noreferrer">{r.deviceName}</a> : r.deviceName}</td>
                                <td>
                                  <DuePill state={r.evaluation.state} />
                                </td>
                                <td>
                                  <ProgressMini progress={r.evaluation.progress} state={r.evaluation.state} />
                                </td>
                                <td className="mwo-nowrap">
                                  {r.lastDone?.at ? formatDateTime(r.lastDone.at) : <span className="mwo-muted">never</span>}
                                  {r.lastDone ? <span className="mwo-title-sub">{[r.lastDone.odometerMeters != null ? formatDistance(r.lastDone.odometerMeters, settings.units) : "", r.lastDone.engineSeconds != null ? formatHours(r.lastDone.engineSeconds) : ""].filter(Boolean).join(" · ")}</span> : null}
                                </td>
                                <td>
                                  <ul className="mwo-reasons">
                                    {r.evaluation.reasons.map((x, i) => (
                                      <li key={i}>{x}</li>
                                    ))}
                                  </ul>
                                </td>
                                <td className="mwo-cell-actions">
                                  {r.openWorkOrderId ? (
                                    <button className="mwo-link" onClick={() => onOpenWorkOrder(r.openWorkOrderId!)}>
                                      {open ? formatNumber(open) : "Open order"}
                                    </button>
                                  ) : (
                                    <Button type="tertiary" onClick={() => onCreateWorkOrder(r)}>
                                      Create work order
                                    </Button>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      {shown.length > 500 ? <div className="mwo-table-foot">Showing 500 of {shown.length.toLocaleString()} — narrow with the group picker or search.</div> : null}
                    </div>
                  )
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
