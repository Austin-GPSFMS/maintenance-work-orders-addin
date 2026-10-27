/**
 * Entry point.
 *
 * The MyGeotab add-in lifecycle calls a function registered at
 *   window.geotab.addin.maintenanceWorkOrders
 * which returns { initialize, focus, blur }.
 *
 * Mirrors vehicle-replacement-planner-addin/src/main.tsx: standalone preview
 * fallback (dist/index.html opened directly renders with demo data) and a
 * focus nonce so a returning user gets a fresh load.
 */

import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import App from "./App";
import type { GeotabApi, GeotabPageState } from "./types";
import "./styles.css";

declare global {
  interface Window {
    geotab?: {
      addin?: Record<
        string,
        () => {
          initialize: (api: GeotabApi, state: GeotabPageState, callback: () => void) => void;
          focus: (api: GeotabApi, state: GeotabPageState) => void;
          blur: () => void;
        }
      >;
    };
  }
}

let root: Root | null = null;
let currentApi: GeotabApi | null = null;
let currentState: GeotabPageState | null = null;
let focusNonce = 0;

function mount() {
  const container = document.getElementById("root");
  if (!container) {
    console.error("[MWO] #root element not found");
    return;
  }
  if (!root) root = createRoot(container);
  root.render(
    <StrictMode>
      <App api={currentApi} pageState={currentState} focusNonce={focusNonce} />
    </StrictMode>
  );
}

window.geotab = window.geotab || {};
window.geotab.addin = window.geotab.addin || {};
window.geotab.addin.maintenanceWorkOrders = function () {
  return {
    initialize(api, state, callback) {
      currentApi = api;
      currentState = state;
      try {
        mount();
      } catch (e) {
        console.error("[MWO] initialize failed:", e);
      }
      callback();
    },
    focus(api, state) {
      currentApi = api;
      currentState = state;
      focusNonce += 1;
      mount();
    },
    blur() {
      // No-op.
    },
  };
};

// Standalone load: paint the App with no api if MyGeotab never calls
// initialize within 500ms (someone opened dist/index.html directly).
if (typeof window !== "undefined") {
  const standaloneTimer = window.setTimeout(() => {
    if (!root) {
      console.warn("[MWO] No MyGeotab initialize() detected — rendering standalone preview.");
      mount();
    }
  }, 500);
  const origInit = window.geotab!.addin!.maintenanceWorkOrders;
  window.geotab!.addin!.maintenanceWorkOrders = function () {
    window.clearTimeout(standaloneTimer);
    return origInit();
  };
}
