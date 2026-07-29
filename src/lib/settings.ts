// Lightweight client-only preferences kept in localStorage (no Dexie/sync needed — these are
// device-level UI choices, not synced golf data). Centralized here so the key and its default
// live in one place instead of being duplicated between SettingsPage and RoundMapPage.

export const GPS_ENABLED_KEY = "caddyshot_gps_enabled";

/** Whether live GPS should drive the round map. Defaults to true (on) when unset — the value is
 * only ever stored once the user explicitly flips the Settings toggle. */
export function isGpsEnabled(): boolean {
  if (typeof localStorage === "undefined") return true;
  return localStorage.getItem(GPS_ENABLED_KEY) !== "false";
}

export function setGpsEnabled(enabled: boolean): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(GPS_ENABLED_KEY, enabled ? "true" : "false");
}

export const SIMULATION_KEY = "caddyshot_simulation_mode";

/** Simulation ("couch") mode: real GPS is ignored and the player's position is placed by tapping
 * the map, with on-screen buttons standing in for the watch lap press and an NFC club tap — so a
 * round can be rehearsed indoors before trusting the workflow on the course. Off by default. */
export function isSimulationEnabled(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(SIMULATION_KEY) === "true";
}

export function setSimulationEnabled(enabled: boolean): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(SIMULATION_KEY, enabled ? "true" : "false");
}
