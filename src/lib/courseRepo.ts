import { db } from "./db";
import type { ParsedCourse } from "./importOverpass";
import type { Club, Course, CourseVersion, FeatureType, Hole, HoleFeature, TeeBox } from "../types/domain";

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

// z-order resolves overlapping polygons during lie-detection (higher wins). See DESIGN.md §5.
const Z_ORDER: Record<FeatureType, number> = {
  fringe: 4,
  green: 3,
  bunker_greenside: 3,
  bunker_fairway: 2,
  tee: 2,
  hazard: 2,
  fairway: 1,
  rough: 0,
  ob: 5
};

async function queueOutbox(table: string, op: "upsert" | "delete", payload: unknown) {
  await db.outbox.put({ id: uuid(), table, op, payload, createdAt: now() });
}

/**
 * Persists a parsed Overpass import as a new course version. If a course with
 * the same name already exists, this adds a new version under it (copy-on-write,
 * DESIGN.md §7) rather than duplicating the course.
 */
export async function saveImportedCourse(parsed: ParsedCourse): Promise<{ courseId: string; courseVersionId: string }> {
  return db.transaction("rw", [db.courses, db.courseVersions, db.holes, db.holeFeatures, db.teeBoxes, db.outbox], async () => {
    let course = await db.courses.where("name").equals(parsed.name).first();

    if (!course) {
      course = {
        id: uuid(),
        name: parsed.name,
        location: parsed.location,
        updatedAt: now(),
        deletedAt: null
      };
      await db.courses.put(course);
      await queueOutbox("courses", "upsert", course);
    }

    const existingVersions = await db.courseVersions.where("courseId").equals(course.id).toArray();
    const versionNumber = existingVersions.length ? Math.max(...existingVersions.map((v) => v.versionNumber)) + 1 : 1;

    const courseVersion: CourseVersion = {
      id: uuid(),
      courseId: course.id,
      versionNumber,
      effectiveFrom: now(),
      source: "overpass_import",
      updatedAt: now()
    };
    await db.courseVersions.put(courseVersion);
    await queueOutbox("courseVersions", "upsert", courseVersion);

    const holeIdByNumber = new Map<number, string>();
    for (const h of parsed.holes) {
      const hole: Hole = {
        id: uuid(),
        courseVersionId: courseVersion.id,
        number: h.number,
        par: h.par,
        defaultYardage: h.defaultYardage,
        updatedAt: now()
      };
      holeIdByNumber.set(h.number, hole.id);
      await db.holes.put(hole);
      await queueOutbox("holes", "upsert", hole);
    }

    for (const f of parsed.features) {
      const holeId = holeIdByNumber.get(f.holeNumber);
      if (!holeId) continue;
      const feature: HoleFeature = {
        id: uuid(),
        holeId,
        featureType: f.featureType,
        geometry: f.geometry,
        zOrder: Z_ORDER[f.featureType]
      };
      await db.holeFeatures.put(feature);
      await queueOutbox("holeFeatures", "upsert", feature);
    }

    for (const t of parsed.teeBoxes) {
      const holeId = holeIdByNumber.get(t.holeNumber);
      if (!holeId) continue;
      const teeBox: TeeBox = { id: uuid(), holeId, name: t.name, location: t.location };
      await db.teeBoxes.put(teeBox);
      await queueOutbox("teeBoxes", "upsert", teeBox);
    }

    return { courseId: course.id, courseVersionId: courseVersion.id };
  });
}

export async function listCourses(): Promise<Course[]> {
  const all = await db.courses.toArray();
  return all.filter((c) => !c.deletedAt);
}

export async function getLatestCourseVersion(courseId: string): Promise<CourseVersion | undefined> {
  const versions = await db.courseVersions.where("courseId").equals(courseId).toArray();
  return versions.sort((a, b) => b.versionNumber - a.versionNumber)[0];
}

export async function getHolesForVersion(courseVersionId: string): Promise<Hole[]> {
  return (await db.holes.where("courseVersionId").equals(courseVersionId).toArray()).sort((a, b) => a.number - b.number);
}

export async function getFeaturesForHole(holeId: string): Promise<HoleFeature[]> {
  return db.holeFeatures.where("holeId").equals(holeId).toArray();
}

const DEFAULT_CLUB_NAMES = ["Driver", "5 Wood", "4 Iron", "5 Iron", "6 Iron", "7 Iron", "8 Iron", "9 Iron", "50°", "56°", "60°", "Putter"];
// Names only ever seeded by the old default list — presence of any of these means this
// install still has the pre-migration clubs and needs a one-time reseed onto the new list.
const LEGACY_ONLY_CLUB_NAMES = ["3 Wood", "PW", "GW", "SW", "LW"];

export async function ensureDefaultClubs(): Promise<Club[]> {
  // Whole read-check-write runs as one Dexie transaction so two concurrent callers (e.g.
  // React StrictMode's dev-only double effect invocation) can't both see "empty"/"legacy"
  // and each seed their own duplicate batch — IndexedDB serializes same-store rw
  // transactions, so the second call sees the first's already-committed result.
  return db.transaction("rw", db.clubs, async () => {
    const existing = await db.clubs.toArray();
    const hasLegacy = existing.some((c) => LEGACY_ONLY_CLUB_NAMES.includes(c.name));
    if (existing.length && !hasLegacy) return existing;
    if (hasLegacy) await db.clubs.clear();

    const clubs: Club[] = DEFAULT_CLUB_NAMES.map((name, i) => ({ id: uuid(), name, sortOrder: i, updatedAt: now() }));
    await db.clubs.bulkPut(clubs);
    return clubs;
  });
}
