/** Sortable work-order list. Row click opens the editor. */

import { useMemo, useState } from "react";
import { Button } from "@geotab/zenith";
import type { GeotabSession, Settings, WorkOrder } from "../types";
import { formatDate, formatDateTime, formatMoney } from "../utils/format";
import { CLAIM_STATUS_LABEL, PRIORITY_LABEL, PRIORITY_ORDER, STATUS_LABEL, formatNumber, isOverdue, totals } from "../utils/workorders";
import { useViewport } from "../utils/viewport";

type SortKey = "number" | "vehicle" | "title" | "status" | "priority" | "assignee" | "due" | "updated" | "total";

interface Props {
  rows: WorkOrder[];
  settings: Settings;
  session: GeotabSession | null;
  busy: boolean;
  onOpen: (wo: WorkOrder) => void;
}

const PAGE = 200;

export function vehicleLink(session: GeotabSession | null, deviceId: string): string | null {
  if (!session) return null;
  return `https://${session.server}/${session.database}/#device,id:${deviceId}`;
}

export function StatusPill({ wo }: { wo: WorkOrder }) {
  const cls =
    wo.status === "completed" ? "mwo-pill-ok" : wo.status === "cancelled" ? "mwo-pill-muted" : wo.status === "in_progress" ? "mwo-pill" : wo.status === "on_hold" ? "mwo-pill-info" : "mwo-pill-purple";
  return <span className={`mwo-pill ${cls}`}>{STATUS_LABEL[wo.status]}</span>;
}

export function PriorityPill({ wo }: { wo: WorkOrder }) {
  const cls = wo.priority === "critical" ? "mwo-pill-warn" : wo.priority === "high" ? "mwo-pill-info" : wo.priority === "low" ? "mwo-pill-muted" : "mwo-pill";
  return <span className={`mwo-pill ${cls}`}>{PRIORITY_LABEL[wo.priority]}</span>;
}

export function WarrantyPill({ wo }: { wo: WorkOrder }) {
  if (wo.warranty.isWarrantyWork) {
    const c = wo.warranty.claim.status;
    const cls = c === "paid" || c === "approved" ? "mwo-pill-ok" : c === "denied" ? "mwo-pill-warn" : "mwo-pill-ok";
    return (
      <span className={`mwo-pill ${cls}`} title={wo.warranty.coverageLabel}>
        Warranty{c !== "none" ? ` · ${CLAIM_STATUS_LABEL[c]}` : ""}
      </span>
    );
  }
  if (wo.warranty.eligible) return <span className="mwo-pill mwo-pill-muted" title={`In coverage: ${wo.warranty.coverageLabel}`}>Eligible</span>;
  return null;
}

export function WorkOrderTable({ rows, settings, session, busy, onOpen }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("updated");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [limit, setLimit] = useState(PAGE);
  const vp = useViewport();
  const now = new Date();

  const sorted = useMemo(() => {
    const val = (w: WorkOrder): string | number => {
      switch (sortKey) {
        case "number":
          return w.number;
        case "vehicle":
          return w.deviceName.toLowerCase();
        case "title":
          return w.title.toLowerCase();
        case "status":
          return w.status;
        case "priority":
          return PRIORITY_ORDER.indexOf(w.priority);
        case "assignee":
          return w.assigneeName.toLowerCase();
        case "due":
          return w.dueDate ?? "9999";
        case "updated":
          return w.updatedAt;
        case "total":
          return totals(w).total;
      }
    };
    return [...rows].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return c * sortDir || b.number - a.number;
    });
  }, [rows, sortKey, sortDir]);

  const head = (key: SortKey, label: string, cls = "") => (
    <th
      className={`mwo-sortable ${cls} ${sortKey === key ? "mwo-sorted" : ""}`}
      onClick={() => {
        if (sortKey === key) setSortDir((d) => (d === 1 ? -1 : 1));
        else {
          setSortKey(key);
          setSortDir(key === "updated" || key === "number" ? -1 : 1);
        }
      }}
    >
      {label}
      {sortKey === key ? <span className="mwo-sort-arrow">{sortDir === 1 ? "▲" : "▼"}</span> : null}
    </th>
  );

  if (rows.length === 0) return <div className="mwo-empty">No work orders match this view.</div>;

  const visible = sorted.slice(0, limit);
  const more =
    sorted.length > visible.length ? (
      <div className="mwo-table-foot">
        <span>
          Showing {visible.length.toLocaleString()} of {sorted.length.toLocaleString()}
        </span>
        <Button type="tertiary" onClick={() => setLimit((l) => l + PAGE)}>
          Show more
        </Button>
        <Button type="tertiary" onClick={() => setLimit(sorted.length)}>
          Show all
        </Button>
      </div>
    ) : null;

  // Tablet / MyGeotab mobile app: one tappable card per order instead of a wide table.
  if (vp.tablet) {
    const SORTS: Array<[SortKey, string]> = [["updated", "Recently updated"], ["number", "Number"], ["vehicle", "Vehicle"], ["priority", "Priority"], ["due", "Due date"], ["status", "Status"], ["assignee", "Assignee"], ["total", "Total"]];
    return (
      <div className={`mwo-cards-wrap ${busy ? "mwo-busy" : ""}`}>
        <div className="mwo-cards-sort">
          <label className="mwo-muted mwo-small" htmlFor="mwo-sort">
            Sort by
          </label>
          <select
            id="mwo-sort"
            className="mwo-input mwo-input-sm"
            value={sortKey}
            onChange={(e) => {
              const k = e.target.value as SortKey;
              setSortKey(k);
              setSortDir(k === "updated" || k === "number" ? -1 : 1);
            }}
          >
            {SORTS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          <button className="mwo-link" onClick={() => setSortDir((d) => (d === 1 ? -1 : 1))} aria-label="Reverse sort order">
            {sortDir === 1 ? "▲ ascending" : "▼ descending"}
          </button>
        </div>
        <div className="mwo-cards">
          {visible.map((w) => {
            const t = totals(w);
            const overdue = isOverdue(w, now);
            return (
              <button
                key={w.id ?? w.number}
                type="button"
                className={`mwo-card-row ${w.priority === "critical" ? "mwo-card-critical" : w.priority === "high" ? "mwo-card-high" : ""} ${w.status === "completed" || w.status === "cancelled" ? "mwo-row-done" : ""}`}
                onClick={() => onOpen(w)}
              >
                <div className="mwo-card-row-head">
                  <span className="mwo-wo-number">{formatNumber(w.number)}</span>
                  <span className="mwo-asset">{w.deviceName}</span>
                  <span className="mwo-spacer" />
                  <StatusPill wo={w} />
                </div>
                <div className="mwo-card-row-title">{w.title || "(untitled)"}</div>
                <div className="mwo-card-row-sub">{w.source.type === "manual" ? w.description : w.source.label}</div>
                <div className="mwo-card-row-meta">
                  <PriorityPill wo={w} />
                  <WarrantyPill wo={w} />
                  {overdue ? <span className="mwo-pill mwo-pill-warn">Overdue</span> : null}
                  <span className="mwo-muted">{w.assigneeName || "Unassigned"}</span>
                  {w.dueDate ? <span className="mwo-muted">Due {formatDate(w.dueDate)}</span> : null}
                  <span className="mwo-spacer" />
                  {t.total ? <span className="mwo-strong">{formatMoney(t.total, settings.currency)}</span> : null}
                </div>
              </button>
            );
          })}
        </div>
        {more}
      </div>
    );
  }

  return (
    <div className={`mwo-table-wrap ${busy ? "mwo-busy" : ""}`}>
      <table className="mwo-table">
        <thead>
          <tr>
            {head("number", "#")}
            {head("vehicle", "Vehicle")}
            {head("title", "Work")}
            {head("status", "Status")}
            {head("priority", "Priority")}
            {head("assignee", "Assigned to")}
            {head("due", "Due")}
            <th>Warranty</th>
            {head("total", "Total", "mwo-num")}
            {head("updated", "Updated")}
          </tr>
        </thead>
        <tbody>
          {visible.map((w) => {
            const t = totals(w);
            const overdue = isOverdue(w, now);
            const link = vehicleLink(session, w.deviceId);
            return (
              <tr
                key={w.id ?? w.number}
                className={`mwo-row ${w.priority === "critical" ? "mwo-row-critical" : w.priority === "high" ? "mwo-row-high" : ""} ${w.status === "completed" || w.status === "cancelled" ? "mwo-row-done" : ""}`}
                onClick={() => onOpen(w)}
              >
                <td className="mwo-wo-number">{formatNumber(w.number)}</td>
                <td className="mwo-asset">
                  {link ? (
                    <a href={link} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                      {w.deviceName}
                    </a>
                  ) : (
                    w.deviceName
                  )}
                </td>
                <td>
                  <span className="mwo-title">{w.title || "(untitled)"}</span>
                  <span className="mwo-title-sub">{w.source.type === "manual" ? w.description : w.source.label}</span>
                </td>
                <td>
                  <StatusPill wo={w} />
                </td>
                <td>
                  <PriorityPill wo={w} />
                </td>
                <td>{w.assigneeName || <span className="mwo-muted">Unassigned</span>}</td>
                <td className="mwo-nowrap">
                  {w.dueDate ? formatDate(w.dueDate) : <span className="mwo-muted">—</span>}
                  {overdue ? <span className="mwo-pill mwo-pill-warn" style={{ marginLeft: 6 }}>Overdue</span> : null}
                </td>
                <td>
                  <WarrantyPill wo={w} />
                </td>
                <td className="mwo-num" title={`Warranty ${formatMoney(t.warranty, settings.currency)} · fleet ${formatMoney(t.fleet, settings.currency)}`}>
                  {t.total ? formatMoney(t.total, settings.currency) : "—"}
                </td>
                <td className="mwo-nowrap mwo-muted">{formatDateTime(w.updatedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {more}
    </div>
  );
}
