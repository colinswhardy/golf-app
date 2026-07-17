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

async function courseHasTeeBoxes(courseId: string): Promise<boolean> {
  const versionIds = (await db.courseVersions.where("courseId").equals(courseId).toArray()).map((v) => v.id);
  if (!versionIds.length) return false;
  const holeIds = (await db.holes.where("courseVersionId").anyOf(versionIds).toArray()).map((h) => h.id);
  if (!holeIds.length) return false;
  return (await db.teeBoxes.where("holeId").anyOf(holeIds).count()) > 0;
}

// Deletes a course and everything under it (versions, holes, features, tee boxes) so
// seedBundledCourses's normal "not present" path re-imports it fresh from the (now-fixed)
// parser. Used for the one-time 0-tee-box migration below, not a general-purpose delete.
async function wipeCourse(courseId: string): Promise<void> {
  await db.transaction("rw", [db.courses, db.courseVersions, db.holes, db.holeFeatures, db.teeBoxes], async () => {
    const versionIds = (await db.courseVersions.where("courseId").equals(courseId).toArray()).map((v) => v.id);
    const holeIds = versionIds.length ? (await db.holes.where("courseVersionId").anyOf(versionIds).toArray()).map((h) => h.id) : [];
    if (holeIds.length) {
      await db.holeFeatures.where("holeId").anyOf(holeIds).delete();
      await db.teeBoxes.where("holeId").anyOf(holeIds).delete();
      await db.holes.where("id").anyOf(holeIds).delete();
    }
    if (versionIds.length) await db.courseVersions.where("id").anyOf(versionIds).delete();
    await db.courses.delete(courseId);
  });
}

// Single-flight guard: App.tsx calls seedBundledCourses() from a fire-and-forget mount
// effect, and React StrictMode double-invokes effects in dev — two concurrent calls would
// each see "course not present yet" and both import it, since saveImportedCourse's
// copy-on-write versioning always creates a new version rather than deduping against an
// identical existing one. A second concurrent call just awaits the first's in-flight result.
let seedingPromise: Promise<void> | null = null;

// One-time forced re-seed so installs that already imported Tarandowah/Innerkip before the
// green/tee centerline-endpoint matching fix pick it up. Unlike courseHasTeeBoxes below, this
// wipes unconditionally — a course can have tee boxes and still have them (or its greens)
// mapped to the wrong hole, which tee-box *presence* alone can't detect. Bump this key if a
// future fix needs everyone re-seeded again.
// v3: expanded water-hazard tag detection (natural=water, water=*, waterway=*, creek/stream/
// drain names) and auto-reversal of backward-drawn hole centerlines (Tarandowah holes 1, 9, 11)
// — both parser fixes that only take effect on a fresh import.
const RESEED_VERSION_KEY = "caddyshot_reseeded_v3";

/**
 * Imports any bundled course that isn't already in Dexie. Safe to call on every
 * app start — courses already present (by name) are skipped, so this never
 * creates duplicate versions on repeat runs. Courses already present but with zero
 * tee boxes (from before the OSM parser's centerline fallback existed) get wiped and
 * re-imported so they pick up the fix rather than staying stuck without one forever.
 */
export function seedBundledCourses(): Promise<void> {
  if (!seedingPromise) {
    seedingPromise = seedBundledCoursesOnce().finally(() => {
      seedingPromise = null;
    });
  }
  return seedingPromise;
}

async function seedBundledCoursesOnce(): Promise<void> {
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

  // 1.5. One-time forced re-seed (see RESEED_VERSION_KEY). Flag is only set after the wipes
  // complete without error, so a failure here just retries on the next load.
  if (typeof localStorage !== "undefined" && !localStorage.getItem(RESEED_VERSION_KEY)) {
    try {
      for (const entry of BUNDLED_COURSES) {
        const existing = await db.courses.where("name").equals(entry.name).first();
        if (existing) await wipeCourse(existing.id);
      }
      localStorage.setItem(RESEED_VERSION_KEY, "1");
    } catch (err) {
      console.error("Failed forced re-seed for " + RESEED_VERSION_KEY + ":", err);
    }
  }

  // 2. Normal seeding process
  for (const entry of BUNDLED_COURSES) {
    try {
      const existing = await db.courses.where("name").equals(entry.name).first();
      if (existing) {
        if (await courseHasTeeBoxes(existing.id)) {
          if (existing.isFeatured === undefined) {
            await db.courses.update(existing.id, { isFeatured: true });
          }
          continue;
        }
        await wipeCourse(existing.id);
        // falls through to the normal import below, re-fetching + re-parsing this course
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
