#!/usr/bin/env python3
"""
Second-pass probe for Geotab's Maintenance Center objects found by
probe_geotab_api.py: MaintenanceSchedule and MaintenanceWorkOrder.

What it does
  1. Dumps up to --limit full records of each (every field, nested objects
     included) so we can see the real shape: intervals, status, line items.
  2. Tries search parameters (deviceSearch, fromDate/toDate, groups, id).
  3. Probes neighbouring type names (line items, parts, labour, labels,
     statuses, types, due/forecast objects).
  4. Checks GetFeed for both types (incremental sync).
  5. With --write only: Add a clearly-labelled test MaintenanceWorkOrder on
     one device, Set a field on it, then Remove it — proves write access and
     the minimum Add payload. Everything it creates it deletes; the record
     is tagged "GPSFMS API PROBE" so it is obvious if it ever lingers.

Usage
  cd C:\\Users\\User\\Projects\\maintenance-work-orders-addin\\tools
  python probe_maintenance_center.py --database gpsfms_pilot --username you@gpsfms.com --json mc-results.json
  python probe_maintenance_center.py ... --write --device b123     (device id to test writes against)
"""

import argparse
import getpass
import json
import sys
from datetime import datetime, timedelta, timezone

try:
    import mygeotab
except ImportError:
    sys.exit("pip install mygeotab")

NEIGHBOURS = [
    "MaintenanceWorkOrderItem", "MaintenanceWorkOrderLineItem", "MaintenanceWorkOrderPart", "MaintenanceWorkOrderLabor",
    "MaintenanceWorkOrderLabour", "MaintenanceWorkOrderStatus", "MaintenanceWorkOrderComment", "MaintenanceWorkOrderMedia",
    "MaintenanceWorkOrderCost", "MaintenanceWorkOrderType", "MaintenancePart", "MaintenanceLabor", "MaintenanceService",
    "MaintenanceServiceType", "MaintenanceType", "MaintenanceLabel", "MaintenanceEventType", "MaintenanceScheduleStatus",
    "MaintenanceScheduleEvent", "MaintenanceScheduleDue", "MaintenanceDue", "MaintenanceForecast", "MaintenanceUpcoming",
    "MaintenanceHistory", "MaintenanceCompletedEvent", "MaintenanceReminderDue", "MaintenanceOverdue", "MaintenanceRecordEvent",
    "MaintenanceInvoice", "MaintenanceExpense", "MaintenanceCost", "MaintenanceOdometerReading", "MaintenanceNotification",
    "NotificationTemplate", "Label", "Labels", "MediaFile", "MaintenanceAsset", "MaintenanceAssetStatus", "AssetMaintenanceStatus",
    "MaintenanceScheduleAssignment", "MaintenanceScheduleDevice", "MaintenanceScheduleGroup", "MaintenanceInterval",
    "MaintenanceWorkOrderSearch", "MaintenanceScheduleSearch",
]

METHODS = [
    ("GetMaintenanceWorkOrderSummary", {}), ("GetMaintenanceScheduleStatus", {}), ("GetMaintenanceStatus", {}),
    ("GetMaintenanceDueStatus", {}), ("GetMaintenanceScheduleDue", {}), ("GetMaintenanceForecast", {}),
    ("GetUpcomingMaintenanceEvents", {}), ("GetMaintenanceEvents", {}), ("GetMaintenanceWorkOrderCosts", {}),
    ("GetMaintenanceLabels", {}), ("GetMaintenanceTypes", {}), ("GetMaintenanceCenterFeatureFlags", {}),
]


def short(err) -> str:
    data = getattr(err, "data", None)
    if isinstance(data, dict):
        return f"{data.get('name', '')}: {str(data.get('message', ''))[:160]}"
    return str(err)[:200]


def try_call(api, label, method, **params):
    try:
        r = api.call(method, **params)
        n = len(r) if isinstance(r, list) else 1
        print(f"  OK      {label:60} {n} result(s)")
        return {"label": label, "ok": True, "count": n, "sample": r[:3] if isinstance(r, list) else r}
    except Exception as e:
        msg = short(e)
        print(f"  FAIL    {label:60} {msg[:110]}")
        return {"label": label, "ok": False, "error": msg}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--database", required=True)
    ap.add_argument("--username", required=True)
    ap.add_argument("--server", default="my.geotab.com")
    ap.add_argument("--limit", type=int, default=25, help="records to dump per type")
    ap.add_argument("--json", default="mc-results.json")
    ap.add_argument("--write", action="store_true", help="also test Add/Set/Remove of a MaintenanceWorkOrder (creates then deletes a tagged test record)")
    ap.add_argument("--device", default="", help="device id for the --write test (defaults to the device on the first existing work order)")
    args = ap.parse_args()

    password = getpass.getpass(f"MyGeotab password for {args.username}: ")
    api = mygeotab.API(username=args.username, password=password, database=args.database, server=args.server)
    api.authenticate()
    out = {"database": args.database, "at": datetime.now(timezone.utc).isoformat(), "dumps": {}, "searches": [], "neighbours": [], "methods": [], "feed": [], "write": None}

    # 1. Full dumps.
    for t in ("MaintenanceSchedule", "MaintenanceWorkOrder"):
        try:
            rows = api.call("Get", typeName=t, resultsLimit=args.limit)
            out["dumps"][t] = rows
            keys = sorted({k for r in rows for k in r.keys()}) if rows else []
            print(f"\n== {t}: {len(rows)} record(s); union of fields ({len(keys)}):\n   {', '.join(keys)}")
            if rows:
                print("   first record:\n" + json.dumps(rows[0], indent=2, default=str)[:3000])
        except Exception as e:
            print(f"\n== {t}: FAIL {short(e)}")
            out["dumps"][t] = {"error": short(e)}

    wos = out["dumps"].get("MaintenanceWorkOrder") or []
    first_wo = wos[0] if isinstance(wos, list) and wos else None
    dev_id = args.device or ((first_wo or {}).get("device") or {}).get("id") or ""
    sched = out["dumps"].get("MaintenanceSchedule") or []
    first_sched_id = sched[0].get("id") if isinstance(sched, list) and sched else None

    # 2. Searches.
    print("\n== Search parameters ==")
    now = datetime.now(timezone.utc)
    from_d = (now - timedelta(days=365)).isoformat()
    if first_wo:
        out["searches"].append(try_call(api, "MaintenanceWorkOrder search id", "Get", typeName="MaintenanceWorkOrder", search={"id": first_wo["id"]}))
    if dev_id:
        out["searches"].append(try_call(api, "MaintenanceWorkOrder search deviceSearch", "Get", typeName="MaintenanceWorkOrder", search={"deviceSearch": {"id": dev_id}}, resultsLimit=50))
    out["searches"].append(try_call(api, "MaintenanceWorkOrder search fromDate/toDate", "Get", typeName="MaintenanceWorkOrder", search={"fromDate": from_d, "toDate": now.isoformat()}, resultsLimit=50))
    out["searches"].append(try_call(api, "MaintenanceWorkOrder search includeCompleted", "Get", typeName="MaintenanceWorkOrder", search={"includeCompleted": True}, resultsLimit=50))
    out["searches"].append(try_call(api, "MaintenanceWorkOrder propertySelector", "Get", typeName="MaintenanceWorkOrder", propertySelector={"fields": ["id", "device", "dateTime"], "isIncluded": True}, resultsLimit=5))
    if first_sched_id:
        out["searches"].append(try_call(api, "MaintenanceSchedule search id", "Get", typeName="MaintenanceSchedule", search={"id": first_sched_id}))
        out["searches"].append(try_call(api, "MaintenanceWorkOrder search maintenanceScheduleSearch", "Get", typeName="MaintenanceWorkOrder", search={"maintenanceScheduleSearch": {"id": first_sched_id}}, resultsLimit=50))
    if dev_id:
        out["searches"].append(try_call(api, "MaintenanceSchedule search deviceSearch", "Get", typeName="MaintenanceSchedule", search={"deviceSearch": {"id": dev_id}}, resultsLimit=50))
    out["searches"].append(try_call(api, "MaintenanceSchedule search groups", "Get", typeName="MaintenanceSchedule", search={"groups": [{"id": "GroupCompanyId"}]}, resultsLimit=50))
    out["searches"].append(try_call(api, "MaintenanceSchedule search active", "Get", typeName="MaintenanceSchedule", search={"active": True}, resultsLimit=50))
    out["searches"].append(try_call(api, "MaintenanceWorkOrder Get resultsLimit 5000 (count)", "Get", typeName="MaintenanceWorkOrder", resultsLimit=5000))
    out["searches"].append(try_call(api, "MaintenanceSchedule Get resultsLimit 5000 (count)", "Get", typeName="MaintenanceSchedule", resultsLimit=5000))

    # 3. Neighbour types.
    print("\n== Neighbouring types ==")
    for t in NEIGHBOURS:
        r = try_call(api, f"Get {t}", "Get", typeName=t, resultsLimit=5)
        r["type"] = t
        out["neighbours"].append(r)

    # 4. Methods.
    print("\n== Methods ==")
    for m, p in METHODS:
        out["methods"].append(try_call(api, m, m, **p))

    # 5. GetFeed.
    print("\n== GetFeed ==")
    for t in ("MaintenanceWorkOrder", "MaintenanceSchedule"):
        out["feed"].append(try_call(api, f"GetFeed {t}", "GetFeed", typeName=t, resultsLimit=10))

    # 6. Optional write test.
    if args.write:
        print("\n== Write test (Add → Set → Remove) ==")
        if not dev_id:
            print("  no device id — pass --device")
        else:
            tag = f"GPSFMS API PROBE {now.strftime('%Y-%m-%d %H:%M')} — safe to delete"
            # Start from the shape of an existing record, keep only plausible writable fields.
            entity = {"device": {"id": dev_id}, "dateTime": now.isoformat(), "notes": tag, "reference": "GPSFMS-PROBE", "priorityCode": (first_wo or {}).get("priorityCode", "Medium")}
            if first_wo:
                for k in ("costCurrency", "status", "type", "maintenanceType", "labels", "title", "name", "summary", "description"):
                    if k in first_wo and k not in entity and k not in ("id", "version"):
                        entity[k] = first_wo[k]
            added = try_call(api, "Add MaintenanceWorkOrder (minimal)", "Add", typeName="MaintenanceWorkOrder", entity=entity)
            out["write"] = {"attempt": entity, "add": added}
            new_id = added.get("sample") if added.get("ok") else None
            if isinstance(new_id, str):
                got = try_call(api, "Get the added record", "Get", typeName="MaintenanceWorkOrder", search={"id": new_id})
                out["write"]["get"] = got
                rec = (got.get("sample") or [None])[0] if got.get("ok") else None
                if rec:
                    rec["notes"] = tag + " (edited)"
                    out["write"]["set"] = try_call(api, "Set notes on the added record", "Set", typeName="MaintenanceWorkOrder", entity=rec)
                out["write"]["remove"] = try_call(api, "Remove the added record", "Remove", typeName="MaintenanceWorkOrder", entity={"id": new_id})
            elif added.get("ok"):
                print("  Add returned something other than an id:", added.get("sample"))

    with open(args.json, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, default=str)
    print(f"\nWrote {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
