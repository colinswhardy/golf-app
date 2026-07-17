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
  // 1. Upgrade existing seeded default courses to ensure they have the isFeatured property
  try {
    const defaultCourseNames = BUNDLED_COURSES.map((c) => c.name);
    const existingFeatured = await db.courses.where("name").anyOf(defaultCourseNames).toArray();
    for (const c of existingFeatured) {
      if (c.isFeatured === undefined) {
        await db.courses.update(c.id, { isFeatured: true });
      }
    }
  } catch (err) {
    console.error("Failed to upgrade existing courses:", err);
  }

  // 2. Normal seeding process
  for (const entry of BUNDLED_COURSES) {
    try {
      const existing = await db.courses.where("name").equals(entry.name).first();
      if (existing) {
        if (existing.isFeatured === undefined) {
          await db.courses.update(existing.id, { isFeatured: true });
        }
        continue;
      }

      const res = await fetch(`${import.meta.env.BASE_URL}${entry.file}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const geojson = await res.json();
      const parsed = parseOverpassGeoJson(geojson);
      const ids = await saveImportedCourse(parsed);
      
      // Update isFeatured for newly seeded courses
      await db.courses.update(ids.courseId, { isFeatured: true });
    } catch (e) {
      console.error(`Failed to seed bundled course "${entry.name}":`, e);
    }
  }
}
