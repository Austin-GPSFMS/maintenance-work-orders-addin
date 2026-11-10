/** Bundled by test/*.mjs via esbuild so the tests share the app's pure logic + demo fleet. */
export { makeDemoFleet } from "../src/utils/demo";
export { ADDIN_DATA_ID } from "../src/api/store";
export * from "../src/utils/warranty";
export * from "../src/utils/workorders";
export * from "../src/utils/format";
export * from "../src/utils/geotabMerge";
export { normalizeSchedule, normalizeJob, isUserReminder, timeSpanToSeconds, secondsToTimeSpan, composeNotes, splitNotes, NOTES_MARKER } from "../src/api/maintenanceCenter";
export { DEFAULT_SETTINGS } from "../src/utils/storage";
export { stringList, isFaultActive } from "../src/api/geotab";
