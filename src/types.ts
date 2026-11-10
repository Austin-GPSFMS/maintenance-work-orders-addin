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
  /** Shape varies by server build: array, comma string, or a flags object — parsed with stringList(). */
  faultStates?: unknown;
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
  /** Geotab maintenanceType id (reminder rule's type), for schedule-sourced orders. */
  maintenanceTypeId?: string;
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
  /** Link to Geotab's Maintenance Center order (null = not synced / sync failed). */
  geotab: GeotabLink | null;
}

export interface GeotabLink {
  /** MaintenanceWorkOrder id. */
  id: string;
  /** Geotab's sequential reference ("000161"); the display number when linked. */
  reference: string;
  /** Raw statusCode last seen on the Geotab record. */
  statusCode: number;
  /** MaintenanceWorkOrderJob id created for a reminder, when any. */
  jobId: string | null;
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
// Geotab Maintenance Center (undocumented API — see tools/probe_*.py and
// the project note "Geotab Maintenance Center — undocumented API findings")
// ---------------------------------------------------------------------------

/** Raw MaintenanceSchedule as MyGeotab returns it (fields we read). */
export interface GeotabMaintenanceSchedule {
  id: string;
  name?: string;
  active?: boolean;
  comment?: string;
  source?: string; // "manual" | "Data Insight"
  groups?: Array<{ id: string }>;
  labels?: string[];
  kilometers?: number | null;
  months?: number | null;
  days?: number | null;
  eventDate?: string | null;
  eventType?: { id: string } | string;
  maintenanceType?: GeotabMaintenanceType;
  version?: string;
}

export interface GeotabMaintenanceType {
  id: string;
  name?: string;
  source?: string;
  customSource?: string;
  sourceType?: string; // "Scheduled" | "DataInsight" | "Manual"
  createdBy?: { id: string } | string;
  labels?: string[];
  defect?: { id: string; isDefectList?: boolean };
  activeFrom?: string;
  activeTo?: string;
  version?: string;
}

/** Raw MaintenanceWorkOrder (fields we read / write). */
export interface GeotabMaintenanceWorkOrder {
  id: string;
  reference?: string;
  device?: { id: string; name?: string; groups?: Array<{ id: string }> };
  dateTime?: string;
  updatedDate?: string;
  statusCode?: number;
  priorityCode?: number;
  notes?: string | null;
  odometerReading?: number;
  engineHoursReading?: string;
  engineHoursReadingInHours?: number;
  completedDateTime?: string | null;
  assignedTo?: { id: string; name?: string } | string | null;
  zone?: { id: string } | null;
  repairReason?: number | null;
  repairClass?: number | null;
  costCurrency?: string;
  totalCost?: number;
  laborCost?: number;
  partsCost?: number;
  taxCost?: number;
  shippingCost?: number;
  miscCost?: number;
  taxAddedToTotal?: boolean;
  mediaFiles?: unknown[];
  openedByUser?: { id: string; name?: string } | string;
  version?: string;
}

/** Raw MaintenanceWorkOrderJob. */
export interface GeotabMaintenanceJob {
  id: string;
  workOrder?: { id: string };
  schedule?: { id: string };
  device?: { id: string; name?: string };
  maintenanceType?: GeotabMaintenanceType;
  statusCode?: number;
  severityCode?: number;
  triggeredDate?: string;
  dateTime?: string;
  odometerReading?: number;
  engineHoursReading?: string;
  engineHoursReadingInHours?: number;
  laborCosts?: number;
  partsCost?: number;
  version?: string;
}

/** Normalized reminder rule (from MaintenanceSchedule). */
export interface ReminderRule {
  id: string;
  name: string;
  active: boolean;
  /** "manual" rules only; Geotab's Data Insight rules are filtered out. */
  source: string;
  groupIds: string[];
  labels: string[];
  intervalMeters: number | null;
  intervalDays: number | null;
  intervalMonths: number | null;
  /** One-off due date. */
  eventDate: string | null;
  maintenanceTypeId: string | null;
  maintenanceTypeName: string;
  /** Raw maintenanceType, replayed into a job when a work order is created. */
  maintenanceType: GeotabMaintenanceType | null;
}

/** Normalized job. */
export interface ReminderJob {
  id: string;
  workOrderId: string;
  scheduleId: string | null;
  deviceId: string;
  maintenanceTypeId: string | null;
  maintenanceTypeName: string;
  defectId: string | null;
  statusCode: number;
  severityCode: number;
  triggeredDate: string | null;
  odometerMeters: number | null;
  engineSeconds: number | null;
}

/** One reminder applied to one vehicle. */
export interface ReminderVehicleRow {
  key: string;
  rule: ReminderRule;
  deviceId: string;
  deviceName: string;
  evaluation: ScheduleEvaluation;
  /** Last completed job for this rule + vehicle (what "last done" came from). */
  lastDone: { at: string | null; odometerMeters: number | null; engineSeconds: number | null } | null;
  openWorkOrderId: string | null;
}

// ---------------------------------------------------------------------------
// Service schedules — now only the evaluation input shape built from a
// ReminderRule + the vehicle's last completed job (the add-in no longer
// stores its own schedules)
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
  /** woKey() of an active order already created from this defect. */
  openWorkOrderKey: string | null;
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
  openWorkOrderKey: string | null;
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
  /** Write orders to Geotab's Maintenance Center (MaintenanceWorkOrder) and list its orders. */
  syncToGeotab: boolean;
  /** Add-in status → Geotab statusCode. 1 = open and 5 = completed are confirmed; the rest are editable guesses. */
  statusCodeMap: Record<WorkOrderStatus, number>;
  /** Add-in priority → Geotab priorityCode (100 is Geotab's default). */
  priorityCodeMap: Record<WorkOrderPriority, number>;
  /** Add-in priority → job severityCode (0 / 100 / 200 seen on pilot). */
  severityCodeMap: Record<WorkOrderPriority, number>;
}

export interface Progress {
  text: string;
  pct: number | null;
}

export interface StoreData {
  workOrders: WorkOrder[];
  coverages: WarrantyCoverage[];
  /** Legacy add-in schedules (pre-Maintenance-Center builds); read for migration only. */
  schedules: ServiceSchedule[];
}
