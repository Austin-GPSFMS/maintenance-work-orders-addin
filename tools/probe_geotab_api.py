#!/usr/bin/env python3
"""
Probe a MyGeotab database for API types / methods that are not in the public
reference (maintenance reminders, work orders, ...).

For every candidate it issues one call and classifies the answer:
  EXISTS        the call returned data (count + the first record's field names)
  EXISTS/DENIED the server knows it but this user's clearance can't use it
  UNKNOWN       MyGeotab doesn't recognise the type / method
  ERROR         something else (printed)

Usage (prompts for the password; never stores it):
  cd C:\\Users\\User\\Projects\\maintenance-work-orders-addin\\tools
  pip install mygeotab
  python probe_geotab_api.py --database gpsfms_pilot --username you@gpsfms.com
Options: --server my.geotab.com  --extra Type1,Type2  --json results.json

Undocumented methods are exactly that: Geotab can change or remove them at
any time, so anything found here goes into an add-in behind a feature flag
with the documented path as the fallback.
"""

import argparse
import getpass
import json
import sys
from datetime import datetime, timezone

try:
    import mygeotab
except ImportError:
    sys.exit("pip install mygeotab   (the official Geotab Python client)")

# --- candidates ------------------------------------------------------------

CANDIDATE_TYPES = [
    # maintenance / reminders
    "Reminder", "Reminders", "ReminderRule", "ReminderStatus", "ReminderTemplate",
    "MaintenanceReminder", "MaintenanceReminderRule", "MaintenanceReminderStatus",
    "MaintenanceRule", "MaintenanceRecord", "MaintenanceSchedule", "MaintenanceItem",
    "MaintenanceTask", "MaintenanceEvent", "MaintenanceLog", "MaintenanceTemplate",
    "MaintenanceWorkOrder", "MaintenanceVendor", "MaintenanceStatus", "MaintenanceCenter",
    "ServiceReminder", "ServiceRecord", "ServiceSchedule", "ServiceInterval",
    "WorkOrder", "WorkOrders", "WorkOrderType", "WorkOrderStatus", "Repair", "RepairOrder",
    "VehicleMaintenance", "AssetMaintenance", "Vendor", "Part", "PartsInventory",
    # neighbouring objects that are documented (controls — these should come back EXISTS)
    "Device", "Rule", "DVIRLog", "Defect", "AddInData", "User",
    # newer / rumoured
    "Inspection", "InspectedItem", "DefectList", "AssetProfile", "ServiceAlert", "DeviceReminder",
]

# Methods called with no params (or with a harmless date range when they look like searches).
CANDIDATE_METHODS = [
    "GetReminders", "GetMaintenanceReminders", "GetMaintenanceRecords", "GetMaintenanceRules",
    "GetMaintenanceSchedules", "GetUpcomingMaintenance", "GetDueMaintenance", "GetMaintenanceDue",
    "GetMaintenanceRemindersDue", "GetReminderStatus", "GetWorkOrders", "GetServiceReminders",
    "GetMaintenanceCenterSummary", "GetMaintenanceSummary", "GetVehicleMaintenanceStatus",
    "GetVersionInformation",  # control — documented, should succeed
]

UNKNOWN_HINTS = ("not present", "unknown", "could not find", "not found", "missingmethod", "no method", "invalid type", "cannot be found", "not recognized", "does not exist", "unrecognized")
DENIED_HINTS = ("permission", "not allowed", "security", "clearance", "access", "unauthorized", "forbidden", "not authorized")


def classify(err: Exception) -> tuple[str, str]:
    text = str(err)
    name = ""
    data = getattr(err, "data", None)
    if isinstance(data, dict):
        name = str(data.get("name") or data.get("type") or "")
        text = f"{name}: {data.get('message') or text}"
    low = text.lower()
    if any(h in low for h in UNKNOWN_HINTS):
        return "UNKNOWN", text
    if any(h in low for h in DENIED_HINTS):
        return "EXISTS/DENIED", text
    return "ERROR", text


def summarize(result) -> str:
    if isinstance(result, list):
        first = result[0] if result else None
        keys = sorted(first.keys())[:14] if isinstance(first, dict) else ("<%s>" % type(first).__name__ if result else "")
        return f"{len(result)} rows; fields: {', '.join(keys)}" if result else "0 rows (type exists)"
    if isinstance(result, dict):
        return "object; fields: " + ", ".join(sorted(result.keys())[:14])
    return repr(result)[:120]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--database", required=True)
    ap.add_argument("--username", required=True)
    ap.add_argument("--server", default="my.geotab.com")
    ap.add_argument("--extra", default="", help="comma-separated extra type names to try")
    ap.add_argument("--json", default="", help="write full results here")
    args = ap.parse_args()

    password = getpass.getpass(f"MyGeotab password for {args.username}: ")
    api = mygeotab.API(username=args.username, password=password, database=args.database, server=args.server)
    api.authenticate()
    print(f"\nAuthenticated to {args.database} on {api._server if hasattr(api, '_server') else args.server}\n")

    results = []
    types = CANDIDATE_TYPES + [t.strip() for t in args.extra.split(",") if t.strip()]

    print("== Get {typeName} ==")
    for t in types:
        try:
            r = api.call("Get", typeName=t, resultsLimit=5)
            status, detail = "EXISTS", summarize(r)
        except Exception as e:  # mygeotab.exceptions.MyGeotabException and friends
            status, detail = classify(e)
        results.append({"kind": "type", "name": t, "status": status, "detail": detail})
        print(f"  {status:14} {t:28} {detail[:110]}")

    print("\n== Methods ==")
    for m in CANDIDATE_METHODS:
        try:
            r = api.call(m)
            status, detail = "EXISTS", summarize(r)
        except Exception as e:
            status, detail = classify(e)
            if status == "ERROR" and ("param" in detail.lower() or "argument" in detail.lower()):
                status = "EXISTS/NEEDS-PARAMS"  # the server parsed the method but wants arguments
        results.append({"kind": "method", "name": m, "status": status, "detail": detail})
        print(f"  {status:14} {m:34} {detail[:110]}")

    # Legacy reminders may be Rule entities with a distinctive baseType.
    print("\n== Rule.baseType values in this database ==")
    try:
        rules = api.call("Get", typeName="Rule", resultsLimit=5000)
        by_type = {}
        for r in rules:
            bt = str(r.get("baseType", "?"))
            by_type.setdefault(bt, []).append(r.get("name", ""))
        for bt, names in sorted(by_type.items()):
            print(f"  {bt:34} {len(names):5}  e.g. {', '.join(n for n in names[:3] if n)}")
        results.append({"kind": "rule-basetypes", "name": "Rule.baseType", "status": "EXISTS", "detail": {k: len(v) for k, v in by_type.items()}})
    except Exception as e:
        print("  ", classify(e))

    found = [r for r in results if r["status"].startswith("EXISTS") and r["kind"] in ("type", "method") and r["name"] not in ("Device", "Rule", "DVIRLog", "Defect", "AddInData", "User", "GetVersionInformation")]
    print("\n== Candidates worth a closer look ==")
    for r in found:
        print(f"  {r['kind']:6} {r['name']:30} {r['status']}")
    if not found:
        print("  none — next step is DevTools → Network on the Reminders page (see README).")

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump({"database": args.database, "at": datetime.now(timezone.utc).isoformat(), "results": results}, f, indent=2, default=str)
        print(f"\nWrote {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
