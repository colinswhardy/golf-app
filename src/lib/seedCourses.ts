import { db } from "./db";
import { IMPORTER_VERSION, parseOverpassGeoJson } from "./importOverpass";
import { saveImportedCourse } from "./courseRepo";

// Bundled Overpass exports, shipped as static assets and precached by the service
// worker — so these courses are available on-course with zero network, no manual
// upload. Source-of-truth raw exports also live in data/imports/ for reference;
// these are copies. To add a course this way: drop the .geojson in public/courses/,
// add an entry here (slug = filename), commit+push — it'll auto-seed into everyone's
// Dexie on next load.
//
// `name` is the DISPLAY name and is authoritative — it's passed to saveImportedCourse,
// overriding whatever the OSM boundary polygon is called. For Tarandowah and Innerkip the
// two happen to be identical; for Ussher's Creek they are not, because Legends of the
// Niagara maps all 45 of its holes under a single `leisure=golf_course` polygon named for
// the facility rather than the individual course (see docs/osm-editing-guide.md).
const BUNDLED_COURSES = [
  { name: "Tarandowah Golfers Club", slug: "tarandowah", file: "courses/tarandowah.geojson" },
  { name: "Innerkip Highlands Golf Club", slug: "innerkip-highlands", file: "courses/innerkip-highlands.geojson" },
  { name: "Ussher's Creek", slug: "usshers-creek", file: "courses/usshers-creek.geojson" }
];

// Single-flight guard: App.tsx calls seedBundledCourses() from a fire-and-forget mount
// effect, and React StrictMode double-invokes effects in dev — two concurrent calls would
// each see "course not present yet" and both import it, since saveImportedCourse's
// copy-on-write versioning always creates a new version rather than deduping against an
// identical existing one. A second concurrent call just awaits the first's in-flight result.
let seedingPromise: Promise<void> | null = null;

/**
 * Imports any bundled course that isn't already in Dexie, and ADDITIVELY re-imports (a new
 * CourseVersion under the same course — never a wipe) any whose stored importerVersion is older
 * than the app's IMPORTER_VERSION, so parser fixes propagate without severing historical rounds.
 *
 * REVISION-SPEC 0.2: the old wipeCourse/localStorage-flag re-seed machinery is deliberately gone.
 * It deleted courses/versions/holes/features while leaving rounds/roundHoles/shots pointing at
 * dead UUIDs — see lib/integrity.ts for the repair path that recovers already-orphaned data.
 * Safe to call on every app start; courses at the current importer version are skipped.
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
  for (const entry of BUNDLED_COURSES) {
    try {
      const existing = await db.courses.where("slug").equals(entry.slug).first();

      if (existing && (existing.importerVersion ?? 0) >= IMPORTER_VERSION) {
        if (existing.isFeatured === undefined) {
          await db.courses.update(existing.id, { isFeatured: true });
        }
        continue;
      }

      // Missing entirely, or produced by an older importer: import. saveImportedCourse dedupes
      // by slug, appends a new version, and stamps importerVersion — nothing is deleted.
      const res = await fetch(`${import.meta.env.BASE_URL}${entry.file}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const geojson = await res.json();
      const parsed = parseOverpassGeoJson(geojson);
      const ids = await saveImportedCourse(parsed, { slug: entry.slug, name: entry.name });
      await db.courses.update(ids.courseId, { isFeatured: true });
    } catch (e) {
      console.error(`Failed to seed bundled course "${entry.name}":`, e);
    }
  }
}
