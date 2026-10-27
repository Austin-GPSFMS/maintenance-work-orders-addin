/** KPI strip for the work-order list, using Zenith SummaryTiles. */

import { SummaryTile, SummaryTileBar, SummaryTileType } from "@geotab/zenith";
import type { Settings, WorkOrder } from "../types";
import { formatInt, formatMoney } from "../utils/format";
import { isOverdue, matchesView, totals, type ViewFilter } from "../utils/workorders";

interface SummaryProps {
  rows: WorkOrder[];
  settings: Settings;
  active: ViewFilter;
  onPick: (v: ViewFilter) => void;
}

export function Summary({ rows, settings, active, onPick }: SummaryProps) {
  const now = new Date();
  const count = (v: ViewFilter) => rows.filter((w) => matchesView(w, v, now)).length;
  const tile = (v: ViewFilter) => (active === v ? SummaryTileType.Active : SummaryTileType.Default);
  const since = now.getTime() - 30 * 86400000;
  const completed30 = rows.filter((w) => w.status === "completed" && w.completedAt && new Date(w.completedAt).getTime() >= since);
  const spend30 = completed30.reduce((s, w) => s + totals(w).fleet, 0);
  const warranty30 = completed30.reduce((s, w) => s + totals(w).warranty, 0);
  const overdue = rows.filter((w) => isOverdue(w, now)).length;

  return (
    <SummaryTileBar aria-label="Work order summary">
      <SummaryTile title="Open" tileType={tile("open")} onClick={() => onPick("open")}>
        <span className="mwo-tile-value mwo-tile-blue">{formatInt(count("open"))}</span>
      </SummaryTile>
      <SummaryTile title="In progress" tileType={tile("in_progress")} onClick={() => onPick("in_progress")}>
        <span className="mwo-tile-value">{formatInt(count("in_progress"))}</span>
      </SummaryTile>
      <SummaryTile title="Overdue" tileType={tile("overdue")} onClick={() => onPick("overdue")} tooltipText="Active orders whose due date has passed.">
        <span className={`mwo-tile-value ${overdue ? "mwo-tile-warn" : "mwo-tile-muted"}`}>{formatInt(overdue)}</span>
      </SummaryTile>
      <SummaryTile title="Warranty work" tileType={tile("warranty")} onClick={() => onPick("warranty")} tooltipText="Orders flagged as warranty work (any status).">
        <span className="mwo-tile-value mwo-tile-ok">{formatInt(count("warranty"))}</span>
      </SummaryTile>
      <SummaryTile title="Claims to chase" tileType={tile("claims")} onClick={() => onPick("claims")} tooltipText="Warranty claims still to be filed or awaiting the provider.">
        <span className={`mwo-tile-value ${count("claims") ? "mwo-tile-info" : "mwo-tile-muted"}`}>{formatInt(count("claims"))}</span>
      </SummaryTile>
      <SummaryTile title="Completed · 30 days" tileType={tile("completed")} onClick={() => onPick("completed")} tooltipText={`Fleet cost ${formatMoney(spend30, settings.currency)} · warranty-covered ${formatMoney(warranty30, settings.currency)}`}>
        <span className="mwo-tile-value">{formatInt(completed30.length)}</span>
        <span className="mwo-muted mwo-small"> {formatMoney(spend30, settings.currency)}</span>
      </SummaryTile>
    </SummaryTileBar>
  );
}
