import { db } from "./db";
import { parseOverpassGeoJson } from "./importOverpass";
import { saveImportedCourse } from "./courseRepo";

// Bundled Overpass exports, shipped as static assets and precached by the service
// worker — so these courses are available on-course with zero network, no manual
// upload. Source-of-truth raw exports also live in data/imports/ for reference;
// these are copies. To add a course this way: drop the .geojson in public/courses/,
// add an entry here, commit+push — it'll auto-seed into everyone's Dexie on next load.
const BUNDLED_COURSES = [
  { name: "Tarandowah Golfers Club", file: "courses/tarandowah.geojson" },
  { name: "Innerkip Highlands Golf Club", file: "courses/innerkip-highlands.geojson" }
];

/**
 * Imports any bundled course that isn't already in Dexie. Safe to call on every
 * app start — courses already present (by name) are skipped, so this never
 * creates duplicate versions on repeat runs.
 */
export async function seedBundledCourses(): Promise<void> {
  for (const entry of BUNDLED_COURSES) {
    const existing = await db.courses.where("name").equals(entry.name).count();
    if (existing > 0) continue;

    try {
      const res = await fetch(`${import.meta.env.BASE_URL}${entry.file}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const geojson = await res.json();
      const parsed = parseOverpassGeoJson(geojson);
      await saveImportedCourse(parsed);
    } catch (e) {
      console.error(`Failed to seed bundled course "${entry.name}":`, e);
    }
  }
}
