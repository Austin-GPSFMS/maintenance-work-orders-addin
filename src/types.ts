/**
 * Domain types for Maintenance Work Orders.
 *
 * The MyGeotab Add-In API is loosely typed; we narrow at the boundary in
 * api/geotab.ts. Geotab shapes mirror the other GPSFMS add-ins
 * (vehicle-replacement-planner-addin/src/types.ts).
 *
 * Everything the add-in *writes* lives in AddInData records (api/store.ts):
 * one record per work order, warranty coverage and service schedule, each
 * tagged with a `kind` so a single `Get AddInData { addInId }` loads the lot.
 */

// ---------------------------------------------------------------------------
// MyGeotab Add-In API surface
// ---------------------------------------------------------------------------

export interface GeotabApi {
  call: (
    method: string,
    params: unknown,
    success: (result: unknown) => void,
    failure: (err: unknown) => void
  ) => void;
  multiCall?: (
    calls: Array<[string, unknown]>,
    success: (result: unknown[]) => void,
    failure: (err: unknown) => void
  ) => void;
  getSession?: (
    callback: (
      credentials: { database: string; userName: string; sessionId: string },
      server: string
    ) => void
  ) => void;
}

export interface GeotabSession {
  server: string;
  database: string;
  userName: string;
  sessionId: string;
}

export interface GeotabPageState {
  getGroupFilter?: (cb: (groups: unknown) => void) => void;
  setGroupFilter?: (groups: unknown) => void;
  getState?: (cb: (state: unknown) => void) => void;
  setState?: (state: unknown) => void;
  translate?: (key: string) => string;
}

export interface GeotabGroup {
  id: string;
  name?: string;
  children?: Array<{ id: string }>;
}

export interface GeotabDevice {
  id: string;
  name?: string;
  serialNumber?: string;
  deviceType?: string;
  activeFrom?: string;
  activeTo?: string;
  groups?: Array<{ id: string }>;
  licensePlate?: string;
  vehicleIdentificationNumber?: string;
  engineVehicleIdentificationNumber?: string;
}

export interface GeotabUser {
  id: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  isDriver?: boolean;
  activeTo?: string;
  companyGroups?: Array<{ id: string }>;
}

export interface GeotabStatusData {
  id?: string;
  device?: { id: string };
  diagnostic?: { id: string };
  dateTime?: string;
  data?: number;
}

export interface GeotabDefectRemark {
  remark?: string;
  dateTime?: string;
  user?: { id: string };
}

export interface GeotabDvirDefect {
  id?: string;
  defect?: { id: string; name?: string };
  part?: { id: string; name?: string };
  defectRemarks?: GeotabDefectRemark[];
  repairStatus?: string; // RepairStatusType: NotRepaired | Repaired | NotNecessary | RepairDisputed
  repairDateTime?: string;
  repairUser?: { id: string };
}

export interface GeotabDvirLog {
  id: string;
  dateTime?: string;
  device?: { id: string };
  trailer?: { id: string };
  driver?: { id: string };
  logType?: string;
  isSafeToOperate?: boolean;
  driverRemark?: string;
  odometer?: number;
  engineHours?: number;
  dVIRDefects?: GeotabDvirDefect[];
  defects?: GeotabDvirDefect[]; // some builds lower-case the property
  repairDate?: string;
  repairedBy?: { id: string };
}

export interface GeotabFaultData {
  id: string;
  dateTime?: string;
  device?: { id: string };
  diagnostic?: { id: string; name?: string; code?: number | string; source?: { id: string } };
  controller?: { id: string; name?: string };
  failureMode?: { id: string; name?: string; code?: number };
  faultState?: string; // None | Pending | Active | Cleared
  faultStates?: string[];
  count?: number;
  severity?: string;
  dismissDateTime?: string;
  dismissUser?: { id: string };
  faultDescription?: string;
  recommendation?: string;
  amberWarningLamp?: boolean;
  redStopLamp?: boolean;
  malfunctionLamp?: boolean;
}

export interface GeotabAddInData {
  id?: string;
  addInId: string;
  details: unknown;
  groups?: Array<{ id: string }>;
}

// ---------------------------------------------------------------------------
// Vehicle snapshot (odometer + engine hours "now")
// ---------------------------------------------------------------------------

export interface VehicleSnapshot {
  deviceId: string;
  /** Adjusted odometer, meters (what MyGeotab displays). */
  odometerMeters: number | null;
  odometerAt: string | null;
  /** Adjusted engine hours, seconds. */
  engineSeconds: number | null;
  engineAt: string | null;
}

// ---------------------------------------------------------------------------
// Work orders
// ---------------------------------------------------------------------------

export type WorkOrderStatus = "open" | "in_progress" | "on_hold" | "completed" | "cancelled";
export type WorkOrderPriority = "low" | "medium" | "high" | "critical";
export type WorkOrderCategory =
  | "preventive"
  | "repair"
  | "inspection"
  | "tires"
  | "electrical"
  | "body"
  | "recall"
  | "telematics"
  | "other";
export type SourceType = "manual" | "dvir" | "fault" | "schedule";
export type LineType = "labor" | "part" | "service" | "fee" | "other";

export interface LineItem {
  id: string;
  type: LineType;
  description: string;
  qty: number;
  unitCost: number;
  /** Line is billed to the warranty provider rather than the fleet. */
  warranty: boolean;
}

export interface WorkOrderSource {
  type: SourceType;
  /** DVIRLog id / FaultData id / schedule id. */
  refId?: string;
  /** DVIRDefect id, when a specific defect was converted. */
  defectId?: string;
  /** Diagnostic id, for faults. */
  diagnosticId?: string;
  /** Short human label ("DVIR 2026-10-20 — Brakes: Air pressure low"). */
  label: string;
}

export type ClaimStatus = "none" | "pending" | "submitted" | "approved" | "denied" | "paid";

export interface WarrantyClaim {
  status: ClaimStatus;
  claimNumber: string;
  submittedAt: string | null;
  resolvedAt: string | null;
  amountClaimed: number | null;
  amountRecovered: number | null;
  notes: string;
}

export interface WorkOrderWarranty {
  /** Evaluated when the order was created / vehicle changed: any active coverage? */
  eligible: boolean;
  /** Coverage the job is being claimed against (user's pick, defaults to the first active one). */
  coverageId: string | null;
  coverageLabel: string;
  /** The user's call: is this warranty work? (defaults to `eligible`). */
  isWarrantyWork: boolean;
  claim: WarrantyClaim;
}

export interface ActivityEntry {
  at: string;
  by: string;
  text: string;
}

export interface WorkOrder {
  /** AddInData record id (undefined until first save). */
  id?: string;
  number: number;
  deviceId: string;
  deviceName: string;
  title: string;
  description: string;
  status: WorkOrderStatus;
  priority: WorkOrderPriority;
  category: WorkOrderCategory;
  assigneeId: string | null;
  assigneeName: string;
  vendor: string;
  invoiceNumber: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  dueDate: string | null;
  startedAt: string | null;
  completedAt: string | null;
  odometerAtOpen: number | null; // meters
  engineSecondsAtOpen: number | null;
  odometerAtClose: number | null;
  engineSecondsAtClose: number | null;
  source: WorkOrderSource;
  lines: LineItem[];
  warranty: WorkOrderWarranty;
  activity: ActivityEntry[];
}

// ---------------------------------------------------------------------------
// Warranty coverage (per vehicle)
// ---------------------------------------------------------------------------

export type CoverageType = "manufacturer" | "powertrain" | "extended" | "emissions" | "component" | "aftermarket" | "other";

export interface WarrantyCoverage {
  id?: string;
  deviceId: string;
  deviceName: string;
  type: CoverageType;
  provider: string;
  policyNumber: string;
  /** What's covered (free text — "bumper to bumper", "transmission + transfer case", ...). */
  components: string;
  startDate: string; // ISO date
  /** Explicit end date; when null, derived from startDate + months. */
  endDate: string | null;
  months: number | null;
  /** Odometer at the start of coverage, meters. */
  startMeters: number | null;
  /** Coverage length in meters (null = unlimited). */
  limitMeters: number | null;
  startEngineSeconds: number | null;
  limitEngineSeconds: number | null;
  notes: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

export type CoverageState = "active" | "expiring" | "expired" | "not_started" | "unknown";

export interface CoverageEvaluation {
  state: CoverageState;
  /** Why (one line per criterion). */
  reasons: string[];
  endsOn: string | null;
  daysLeft: number | null;
  metersLeft: number | null;
  engineSecondsLeft: number | null;
}

// ---------------------------------------------------------------------------
// Service schedules (the add-in's own maintenance reminders)
// ---------------------------------------------------------------------------

export interface ServiceSchedule {
  id?: string;
  deviceId: string;
  deviceName: string;
  name: string; // "Oil change", "DOT inspection"
  category: WorkOrderCategory;
  intervalMeters: number | null;
  intervalEngineSeconds: number | null;
  intervalDays: number | null;
  lastDoneAt: string | null;
  lastDoneMeters: number | null;
  lastDoneEngineSeconds: number | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export type DueState = "overdue" | "due_soon" | "ok" | "unknown";

export interface ScheduleEvaluation {
  state: DueState;
  reasons: string[];
  /** Fraction of the tightest interval consumed (1 = due). */
  progress: number | null;
  /** Already has an open work order from this schedule. */
  openWorkOrderNumber: number | null;
}

// ---------------------------------------------------------------------------
// Intake items ("Needs attention")
// ---------------------------------------------------------------------------

export interface DvirDefectItem {
  key: string;
  logId: string;
  defectId: string;
  deviceId: string;
  deviceName: string;
  dateTime: string;
  driverName: string;
  defectName: string;
  partName: string;
  remarks: string;
  isSafeToOperate: boolean | null;
  repairStatus: string;
  openWorkOrderNumber: number | null;
}

export interface FaultItem {
  key: string;
  faultId: string;
  deviceId: string;
  deviceName: string;
  dateTime: string;
  diagnosticId: string;
  code: string;
  name: string;
  controller: string;
  failureMode: string;
  severity: string;
  count: number;
  description: string;
  recommendation: string;
  lamps: string[];
  openWorkOrderNumber: number | null;
}

// ---------------------------------------------------------------------------
// Settings (per user, localStorage) and app state
// ---------------------------------------------------------------------------

export type DistanceUnit = "mi" | "km";

export interface Settings {
  units: DistanceUnit;
  currency: string;
  dvirLookbackDays: number;
  faultLookbackDays: number;
  /** Warranty "expiring" thresholds. */
  expiringDays: number;
  expiringMeters: number;
  /** Service "due soon" threshold as a fraction of the interval (0.9 = last 10%). */
  dueSoonFraction: number;
  callsPerMinute: number;
  laborRate: number;
}

export interface Progress {
  text: string;
  pct: number | null;
}

export interface StoreData {
  workOrders: WorkOrder[];
  coverages: WarrantyCoverage[];
  schedules: ServiceSchedule[];
}
