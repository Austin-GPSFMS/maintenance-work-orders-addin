#!/usr/bin/env python3
"""
Third-pass probe: MaintenanceWorkOrder jobs, status codes and the full write
cycle (Add → Get → Set to completed → Remove), based on the community payload
and what probe_maintenance_center.py found.

Read-only parts run always; the write cycle only with --write. Everything the
write cycle creates is tagged "GPSFMS API PROBE" and removed at the end
(and the id is printed in case Remove is refused).

  cd C:\\Users\\User\\Projects\\maintenance-work-orders-addin\\tools
  python probe_mc_jobs.py --database gpsfms_pilot --username you@gpsfms.com --json mc-jobs.json
  python probe_mc_jobs.py ... --write [--device b123] [--schedule bBC]
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


def short(err) -> str:
    data = getattr(err, "data", None)
    if isinstance(data, dict):
        return f"{data.get('name', '')}: {str(data.get('message', ''))[:200]}"
    return str(err)[:220]


def attempt(api, label, method, **params):
    try:
        r = api.call(method, **params)
        n = len(r) if isinstance(r, list) else 1
        print(f"  OK      {label:62} {n} result(s)")
        return {"label": label, "ok": True, "count": n, "result": r}
    except Exception as e:
        msg = short(e)
        print(f"  FAIL    {label:62} {msg[:120]}")
        return {"label": label, "ok": False, "error": msg}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--database", required=True)
    ap.add_argument("--username", required=True)
    ap.add_argument("--server", default="my.geotab.com")
    ap.add_argument("--json", default="mc-jobs.json")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--device", default="", help="device id for the write test (default: first device with a GO serial)")
    ap.add_argument("--schedule", default="", help="MaintenanceSchedule id whose maintenanceType the test job uses (default: first active manual schedule)")
    args = ap.parse_args()

    password = getpass.getpass(f"MyGeotab password for {args.username}: ")
    api = mygeotab.API(username=args.username, password=password, database=args.database, server=args.server)
    api.authenticate()
    out = {"database": args.database, "at": datetime.now(timezone.utc).isoformat(), "steps": []}
    log = out["steps"]

    # --- 1. Can Get return the jobs / assignment fields? ---------------------
    print("\n== Reading jobs on existing work orders ==")
    base = attempt(api, "Get MaintenanceWorkOrder (5)", "Get", typeName="MaintenanceWorkOrder", resultsLimit=5)
    log.append(base)
    first = (base.get("result") or [None])[0] if base.get("ok") else None
    if first:
        wid = first["id"]
        for label, params in [
            ("propertySelector workJobs/assignedTo/zone/repairReason/repairClass/jobCount", {"propertySelector": {"fields": ["id", "device", "statusCode", "workJobs", "assignedTo", "zone", "repairReason", "repairClass", "jobCount", "costs", "parts", "labor", "lineItems", "items", "totalCost"], "isIncluded": True}, "search": {"id": wid}}),
            ("search includeWorkJobs", {"search": {"id": wid, "includeWorkJobs": True}}),
            ("search includeJobs", {"search": {"id": wid, "includeJobs": True}}),
            ("search includeDetails", {"search": {"id": wid, "includeDetails": True}}),
            ("search statusCodes [1,2,3,4]", {"search": {"statusCodes": [1, 2, 3, 4]}, "resultsLimit": 50}),
            ("search statusCode 1", {"search": {"statusCode": 1}, "resultsLimit": 50}),
            ("search isCompleted false", {"search": {"isCompleted": False}, "resultsLimit": 50}),
            ("search includeCompleted false", {"search": {"includeCompleted": False}, "resultsLimit": 50}),
            ("search deviceSearch.groups", {"search": {"deviceSearch": {"groups": [{"id": "GroupCompanyId"}]}}, "resultsLimit": 5}),
            ("search updatedFromDate", {"search": {"updatedFromDate": (datetime.now(timezone.utc) - timedelta(days=700)).isoformat()}, "resultsLimit": 5}),
        ]:
            r = attempt(api, f"Get MaintenanceWorkOrder {label}", "Get", typeName="MaintenanceWorkOrder", **params)
            log.append(r)
            if r.get("ok") and r.get("result"):
                keys = sorted({k for row in r["result"] for k in row.keys()})
                extra = [k for k in keys if k in ("workJobs", "assignedTo", "zone", "repairReason", "repairClass", "jobCount", "costs", "parts", "labor", "lineItems", "items", "totalCost")]
                if extra:
                    print(f"          ↳ returned extra fields: {extra}")

    # --- 2. Job-level type names --------------------------------------------
    print("\n== Job / cost type names ==")
    for t in ["WorkJob", "MaintenanceWorkJob", "MaintenanceJob", "WorkOrderJob", "MaintenanceWorkOrderJob", "MaintenanceWorkOrderWorkJob",
              "WorkOrderCost", "MaintenanceWorkOrderCostItem", "WorkOrderItem", "WorkOrderPart", "WorkOrderLabor", "WorkOrderLabour",
              "RepairReason", "RepairClass", "MaintenanceRepairReason", "MaintenanceRepairClass", "MaintenanceTypeSearch", "WorkOrderSearch"]:
        log.append(attempt(api, f"Get {t}", "Get", typeName=t, resultsLimit=5))

    # --- 3. Schedules: which maintenanceType to use, and does deviceSearch really filter? ---
    print("\n== Schedules ==")
    sch = attempt(api, "Get MaintenanceSchedule (all)", "Get", typeName="MaintenanceSchedule", resultsLimit=500)
    log.append(sch)
    schedules = sch.get("result") or []
    manual = [s for s in schedules if s.get("active") and str(s.get("source", "")).lower() == "manual" and isinstance(s.get("maintenanceType"), dict)]
    chosen = next((s for s in manual if s["id"] == args.schedule), None) if args.schedule else (manual[0] if manual else None)
    if chosen:
        print(f"  using schedule {chosen['id']} '{chosen.get('name')}' maintenanceType {chosen['maintenanceType'].get('id')}")
    devs = attempt(api, "Get Device (active, 50)", "Get", typeName="Device", search={"fromDate": datetime.now(timezone.utc).isoformat()}, resultsLimit=50)
    log.append(devs)
    device_id = args.device
    if not device_id:
        for d in devs.get("result") or []:
            if str(d.get("serialNumber", "")).upper().startswith("G") and d.get("id") != "NoDeviceId":
                device_id = d["id"]
                print(f"  using device {device_id} '{d.get('name')}' ({d.get('serialNumber')})")
                break
    if device_id:
        r = attempt(api, "Get MaintenanceSchedule deviceSearch (does it filter?)", "Get", typeName="MaintenanceSchedule", search={"deviceSearch": {"id": device_id}}, resultsLimit=500)
        log.append(r)
        if r.get("ok"):
            print(f"          ↳ {r['count']} of {len(schedules)} schedules returned for this device")

    # --- 4. Write cycle -------------------------------------------------------
    if args.write:
        print("\n== Write cycle ==")
        if not device_id or not chosen:
            print("  need a device and an active manual schedule — pass --device / --schedule")
        else:
            when = (datetime.now(timezone.utc) - timedelta(minutes=10)).replace(microsecond=0)
            tag = f"GPSFMS API PROBE {when.strftime('%Y-%m-%d %H:%M')} — safe to delete"
            mt = chosen["maintenanceType"]
            mt_ref = {k: mt[k] for k in ("id", "name", "source", "customSource", "sourceType", "createdBy") if k in mt}
            entity = {
                "device": {"id": device_id},
                "dateTime": when.isoformat(),
                "reference": f"GPSFMS-PROBE-{when.strftime('%H%M%S')}",
                "priorityCode": 100,
                "statusCode": 1,
                "notes": tag,
                "odometerReading": 0,
                "engineHoursReading": "00:00:00",
                "engineHoursReadingInHours": 0,
                "jobCount": 1,
                "workJobs": [
                    {"device": {"id": device_id}, "severityCode": 0, "statusCode": 1, "triggeredDate": when.isoformat(), "dateTime": when.isoformat(), "maintenanceType": mt_ref}
                ],
            }
            print("  payload:", json.dumps(entity, default=str)[:600])
            added = attempt(api, "Add MaintenanceWorkOrder with one job", "Add", typeName="MaintenanceWorkOrder", entity=entity)
            log.append({"write": "add", "payload": entity, **added})
            new_id = added.get("result") if added.get("ok") and isinstance(added.get("result"), str) else None
            if not new_id and added.get("ok"):
                print("  Add returned:", json.dumps(added.get("result"), default=str)[:300])
            if not new_id:
                # Retry without jobs to learn which part the server objects to.
                slim = {k: v for k, v in entity.items() if k not in ("workJobs", "jobCount")}
                added2 = attempt(api, "Add MaintenanceWorkOrder without jobs", "Add", typeName="MaintenanceWorkOrder", entity=slim)
                log.append({"write": "add-no-jobs", "payload": slim, **added2})
                new_id = added2.get("result") if added2.get("ok") and isinstance(added2.get("result"), str) else None
            if new_id:
                print(f"  created {new_id}")
                got = attempt(api, "Get it back (plain)", "Get", typeName="MaintenanceWorkOrder", search={"id": new_id})
                log.append(got)
                got2 = attempt(api, "Get it back with propertySelector workJobs", "Get", typeName="MaintenanceWorkOrder", search={"id": new_id}, propertySelector={"fields": ["id", "statusCode", "workJobs", "jobCount", "notes"], "isIncluded": True})
                log.append(got2)
                rec = (got.get("result") or [None])[0] if got.get("ok") else None
                if rec:
                    print("  record:", json.dumps(rec, default=str)[:900])
                    upd = dict(rec)
                    upd["notes"] = tag + " (edited)"
                    log.append(attempt(api, "Set notes", "Set", typeName="MaintenanceWorkOrder", entity=upd))
                    done = dict(rec)
                    done["statusCode"] = 5
                    done["completedDateTime"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
                    log.append(attempt(api, "Set statusCode 5 + completedDateTime", "Set", typeName="MaintenanceWorkOrder", entity=done))
                    chk = attempt(api, "Get after Set", "Get", typeName="MaintenanceWorkOrder", search={"id": new_id})
                    log.append(chk)
                    if chk.get("ok") and chk.get("result"):
                        print("  after Set:", json.dumps({k: chk['result'][0].get(k) for k in ('statusCode', 'completedDateTime', 'notes', 'version')}, default=str))
                rm = attempt(api, "Remove", "Remove", typeName="MaintenanceWorkOrder", entity={"id": new_id})
                log.append(rm)
                if not rm.get("ok"):
                    print(f"  !! Remove refused — delete work order {new_id} ('{tag}') in Maintenance Center by hand")

    with open(args.json, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, default=str)
    print(f"\nWrote {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
