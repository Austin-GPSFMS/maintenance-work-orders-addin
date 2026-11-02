/**
 * "Needs attention": the three intake queues that turn into work orders —
 * open DVIR defects, active fault codes, and services that are due.
 */

import { Banner, Button, Tabs } from "@geotab/zenith";
import type { DvirDefectItem, FaultItem, GeotabSession, ReminderVehicleRow, ScheduleEvaluation, Settings, WorkOrder } from "../types";
import { formatDateTime } from "../utils/format";
import { formatNumber, woKey } from "../utils/workorders";
import { vehicleLink } from "./WorkOrderTable";

export type AttentionView = "dvir" | "faults" | "due";

interface Props {
  view: AttentionView;
  onView: (v: AttentionView) => void;
  dvir: DvirDefectItem[] | null;
  faults: FaultItem[] | null;
  due: ReminderVehicleRow[];
  loading: boolean;
  error: string | null;
  settings: Settings;
  session: GeotabSession | null;
  insideMyGeotab: boolean;
  onRefresh: () => void;
  onOpenWorkOrder: (key: string) => void;
  onCreateFromDvir: (item: DvirDefectItem) => void;
  onCreateFromFault: (item: FaultItem) => void;
  onCreateFromReminder: (row: ReminderVehicleRow) => void;
  workOrders: WorkOrder[];
}

function Asset({ session, id, name }: { session: GeotabSession | null; id: string; name: string }) {
  const link = vehicleLink(session, id);
  return <span className="mwo-asset">{link ? <a href={link} target="_blank" rel="noreferrer">{name}</a> : name}</span>;
}

export function AttentionTab(props: Props) {
  const { view, onView, dvir, faults, due, loading, error, settings, session, onRefresh, onOpenWorkOrder, onCreateFromDvir, onCreateFromFault, onCreateFromReminder, workOrders } = props;

  const existingLink = (key: string | null) => {
    if (!key) return null;
    const wo = workOrders.find((w) => woKey(w) === key);
    return (
      <button className="mwo-link" onClick={() => onOpenWorkOrder(key)}>
        {wo ? formatNumber(wo) : "Open order"}
      </button>
    );
  };

  const overdueCount = due.filter((d) => d.evaluation.state === "overdue").length;
  const dueSoonCount = due.filter((d) => d.evaluation.state === "due_soon").length;

  return (
    <div className="mwo-card">
      <div className="mwo-card-head">
        <div className="mwo-tabs-scroll">
        <Tabs
          tabs={[
            { id: "dvir", name: "DVIR defects", quantity: dvir?.length ?? 0 },
            { id: "faults", name: "Active faults", quantity: faults?.length ?? 0 },
            { id: "due", name: "Reminders due", quantity: overdueCount + dueSoonCount },
          ]}
          activeTabId={view}
          onTabChange={(id) => onView(id as AttentionView)}
        />
        </div>
        <div className="mwo-actions">
          <span className="mwo-muted mwo-small">
            {view === "dvir" ? `Unrepaired defects from DVIRs in the last ${settings.dvirLookbackDays} days` : view === "faults" ? `Latest active, undismissed fault per vehicle & code in the last ${settings.faultLookbackDays} days` : "Reminders that are overdue or due soon against each vehicle's current odometer / hours"}
          </span>
          <Button type="secondary" onClick={onRefresh} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </Button>
        </div>
      </div>
      {error ? (
        <Banner type="error" header="Couldn't load this list">
          {error}
        </Banner>
      ) : null}

      {view === "dvir" ? (
        dvir == null ? (
          <div className="mwo-empty">{loading ? "Reading DVIR logs…" : "Press Refresh to load open DVIR defects."}</div>
        ) : dvir.length === 0 ? (
          <div className="mwo-empty">No unrepaired DVIR defects in the selected groups. 🎉</div>
        ) : (
          <div className={`mwo-table-wrap ${loading ? "mwo-busy" : ""}`}>
            <table className="mwo-table">
              <thead>
                <tr>
                  <th>Vehicle</th>
                  <th>Inspection</th>
                  <th>Defect</th>
                  <th>Remarks</th>
                  <th>Driver</th>
                  <th>Safe to operate</th>
                  <th>Work order</th>
                </tr>
              </thead>
              <tbody>
                {dvir.map((d) => (
                  <tr key={d.key} className={d.isSafeToOperate === false ? "mwo-row-critical" : ""}>
                    <td>
                      <Asset session={session} id={d.deviceId} name={d.deviceName} />
                    </td>
                    <td className="mwo-nowrap">{formatDateTime(d.dateTime)}</td>
                    <td>
                      <span className="mwo-title">{d.defectName}</span>
                      {d.partName ? <span className="mwo-title-sub">{d.partName}</span> : null}
                    </td>
                    <td>{d.remarks || <span className="mwo-muted">—</span>}</td>
                    <td>{d.driverName || <span className="mwo-muted">—</span>}</td>
                    <td>{d.isSafeToOperate == null ? <span className="mwo-muted">—</span> : d.isSafeToOperate ? <span className="mwo-pill mwo-pill-ok">Yes</span> : <span className="mwo-pill mwo-pill-warn">No</span>}</td>
                    <td className="mwo-cell-actions">
                      {d.openWorkOrderKey ? (
                        existingLink(d.openWorkOrderKey)
                      ) : (
                        <Button type="tertiary" onClick={() => onCreateFromDvir(d)}>
                          Create work order
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}

      {view === "faults" ? (
        faults == null ? (
          <div className="mwo-empty">{loading ? "Reading fault data…" : "Press Refresh to load active faults."}</div>
        ) : faults.length === 0 ? (
          <div className="mwo-empty">No active faults in the selected groups.</div>
        ) : (
          <div className={`mwo-table-wrap ${loading ? "mwo-busy" : ""}`}>
            <table className="mwo-table">
              <thead>
                <tr>
                  <th>Vehicle</th>
                  <th>Last seen</th>
                  <th>Fault</th>
                  <th>Lamps</th>
                  <th>Count</th>
                  <th>Severity</th>
                  <th>Work order</th>
                </tr>
              </thead>
              <tbody>
                {faults.map((f) => (
                  <tr key={f.key} className={f.lamps.includes("Red stop") ? "mwo-row-critical" : f.lamps.length ? "mwo-row-high" : ""}>
                    <td>
                      <Asset session={session} id={f.deviceId} name={f.deviceName} />
                    </td>
                    <td className="mwo-nowrap">{formatDateTime(f.dateTime)}</td>
                    <td>
                      <span className="mwo-title">{f.name}</span>
                      <span className="mwo-title-sub">{[f.controller, f.failureMode, f.description].filter(Boolean).join(" · ")}</span>
                    </td>
                    <td>
                      {f.lamps.map((l) => (
                        <span key={l} className={`mwo-pill ${l === "Red stop" ? "mwo-pill-warn" : "mwo-pill-info"}`}>
                          {l}
                        </span>
                      ))}
                    </td>
                    <td className="mwo-num">{f.count}</td>
                    <td>{f.severity || <span className="mwo-muted">—</span>}</td>
                    <td className="mwo-cell-actions">
                      {f.openWorkOrderKey ? (
                        existingLink(f.openWorkOrderKey)
                      ) : (
                        <Button type="tertiary" onClick={() => onCreateFromFault(f)}>
                          Create work order
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}

      {view === "due" ? (
        due.length === 0 ? (
          <div className="mwo-empty">Nothing overdue or due soon on MyGeotab's reminders for the selected groups.</div>
        ) : (
          <div className={`mwo-table-wrap ${loading ? "mwo-busy" : ""}`}>
            <table className="mwo-table">
              <thead>
                <tr>
                  <th>Vehicle</th>
                  <th>Reminder</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th>Why</th>
                  <th>Work order</th>
                </tr>
              </thead>
              <tbody>
                {due.map((r) => (
                  <tr key={r.key} className={r.evaluation.state === "overdue" ? "mwo-row-critical" : r.evaluation.state === "due_soon" ? "mwo-row-high" : ""}>
                    <td>
                      <Asset session={session} id={r.deviceId} name={r.deviceName} />
                    </td>
                    <td>
                      <span className="mwo-title">{r.rule.name}</span>
                      <span className="mwo-title-sub">{r.lastDone?.at ? `Last done ${formatDateTime(r.lastDone.at)}` : "No completed service on record"}</span>
                    </td>
                    <td>
                      <DuePill state={r.evaluation.state} />
                    </td>
                    <td>
                      <ProgressMini progress={r.evaluation.progress} state={r.evaluation.state} />
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
                        existingLink(r.openWorkOrderId)
                      ) : (
                        <Button type="tertiary" onClick={() => onCreateFromReminder(r)}>
                          Create work order
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </div>
  );
}

export function DuePill({ state }: { state: ScheduleEvaluation["state"] }) {
  if (state === "overdue") return <span className="mwo-pill mwo-pill-warn">Overdue</span>;
  if (state === "due_soon") return <span className="mwo-pill mwo-pill-info">Due soon</span>;
  if (state === "ok") return <span className="mwo-pill mwo-pill-ok">OK</span>;
  return <span className="mwo-pill mwo-pill-muted">Unknown</span>;
}

export function ProgressMini({ progress, state }: { progress: number | null; state: ScheduleEvaluation["state"] }) {
  if (progress == null) return <span className="mwo-muted">—</span>;
  const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
  return (
    <div className={`mwo-progress-mini ${state === "overdue" ? "mwo-over" : state === "due_soon" ? "mwo-soon" : ""}`} title={`${Math.round(progress * 100)}% of interval used`}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}
