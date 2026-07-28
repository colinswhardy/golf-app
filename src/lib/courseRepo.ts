import { db } from "./db";
import { IMPORTER_VERSION, type ParsedCourse } from "./importOverpass";
import { slugify } from "./slug";
import type { Club, Course, CourseVersion, FeatureType, Hole, HoleFeature, LatLng, TeeBox } from "../types/domain";

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

// z-order resolves overlapping polygons during lie-detection (higher wins). See DESIGN.md §5.
// centerline is not a lie surface — lie detection skips it entirely; 0 here is just a filler
// for non-synthetic centerlines (synthetic ones are stored with zOrder -1, see saveImportedCourse).
const Z_ORDER: Record<FeatureType, number> = {
  fringe: 4,
  green: 3,
  bunker_greenside: 3,
  bunker_fairway: 2,
  tee: 2,
  hazard: 2,
  fairway: 1,
  rough: 0,
  ob: 5,
  centerline: 0
};

async function queueOutbox(table: string, op: "upsert" | "delete", payload: unknown) {
  await db.outbox.put({ id: uuid(), table, op, payload, createdAt: now() });
}

/**
 * Persists a parsed Overpass import as a new course version. Dedupe is by SLUG (stable natural
 * key), not display name: if a course with the same slug already exists, this adds a new version
 * under it (copy-on-write, DESIGN.md §7) rather than duplicating the course. Strictly additive —
 * existing versions/holes/features are never touched, so historical rounds keep resolving.
 */
export async function saveImportedCourse(
  parsed: ParsedCourse,
  opts?: { slug?: string }
): Promise<{ courseId: string; courseVersionId: string }> {
  const slug = opts?.slug ?? slugify(parsed.name);
  return db.transaction("rw", [db.courses, db.courseVersions, db.holes, db.holeFeatures, db.teeBoxes, db.outbox], async () => {
    let course = await db.courses.where("slug").equals(slug).first();

    if (!course) {
      course = {
        id: uuid(),
        name: parsed.name,
        slug,
        importerVersion: IMPORTER_VERSION,
        location: parsed.location,
        updatedAt: now(),
        deletedAt: null
      };
      await db.courses.put(course);
      await queueOutbox("courses", "upsert", course);
    } else {
      // Re-import: record which importer produced the new latest version. Name/location refresh
      // too (OSM data may have been corrected), but nothing under old versions is modified.
      course = { ...course, importerVersion: IMPORTER_VERSION, name: parsed.name, location: parsed.location ?? course.location, updatedAt: now() };
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
        // -1 marks synthetic geometry (fabricated straight tee→green centerlines) per spec 0.4.
        zOrder: f.synthetic ? -1 : Z_ORDER[f.featureType]
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

/** Loads a specific course version by id — review paths use this (a round always renders against
 * the geometry it was played on), while live rounds use getLatestCourseVersion. */
export async function getCourseVersion(courseVersionId: string): Promise<CourseVersion | undefined> {
  return db.courseVersions.get(courseVersionId);
}

export async function getHolesForVersion(courseVersionId: string): Promise<Hole[]> {
  return (await db.holes.where("courseVersionId").equals(courseVersionId).toArray()).sort((a, b) => a.number - b.number);
}

export async function getFeaturesForHole(holeId: string): Promise<HoleFeature[]> {
  return db.holeFeatures.where("holeId").equals(holeId).toArray();
}

export async function getTeeBoxesForHole(holeId: string): Promise<TeeBox[]> {
  return db.teeBoxes.where("holeId").equals(holeId).toArray();
}

/** Overwrites a tee box's coordinate — used by the in-app Course Editor to correct
 * mis-mapped/backward OSM data by hand. Direct overwrite, no versioning: tee boxes aren't
 * course-version-scoped the way holes/features are (see §7 in DESIGN.md). */
export async function updateTeeBoxLocation(teeBoxId: string, location: LatLng): Promise<void> {
  const teeBox = await db.teeBoxes.get(teeBoxId);
  if (!teeBox) return;
  const updated: TeeBox = { ...teeBox, location };
  await db.teeBoxes.put(updated);
  await queueOutbox("teeBoxes", "upsert", updated);
}

/** Updates a hole's freeform notes. Tied to the hole (not a round), so notes persist and
 * reload automatically the next time this course/hole is played, regardless of round. */
export async function updateHoleNotes(holeId: string, notes: string | null): Promise<void> {
  const hole = await db.holes.get(holeId);
  if (!hole) return;
  const updated: Hole = { ...hole, notes, updatedAt: now() };
  await db.holes.put(updated);
  await queueOutbox("holes", "upsert", updated);
}

/** Course-editor override for the green center / aim target (or null to clear it and fall back to
 * the green polygon centroid). Persisted on the hole so it reloads whenever this course is played. */
export async function updateHoleGreenPoint(holeId: string, greenPoint: LatLng | null): Promise<void> {
  const hole = await db.holes.get(holeId);
  if (!hole) return;
  const updated: Hole = { ...hole, greenPoint, updatedAt: now() };
  await db.holes.put(updated);
  await queueOutbox("holes", "upsert", updated);
}

/** Saved mid-hole waypoints (layup/aim points) for a hole, seeded as measure dots when it's next
 * played. Empty array clears them. Persisted on the hole (course-level, not per-round). */
export async function updateHoleWaypoints(holeId: string, waypoints: LatLng[]): Promise<void> {
  const hole = await db.holes.get(holeId);
  if (!hole) return;
  const updated: Hole = { ...hole, waypoints: waypoints.length ? waypoints : null, updatedAt: now() };
  await db.holes.put(updated);
  await queueOutbox("holes", "upsert", updated);
}

/** Creates a new tee box for a hole (course editor) — used to give a playable tee to a hole the
 * OSM import left without one, which otherwise can't render on the round map at all. */
export async function createTeeBox(holeId: string, name: string, location: LatLng): Promise<TeeBox> {
  const teeBox: TeeBox = { id: uuid(), holeId, name, location };
  await db.teeBoxes.put(teeBox);
  await queueOutbox("teeBoxes", "upsert", teeBox);
  return teeBox;
}

const DEFAULT_CLUB_NAMES = ["Driver", "5 Wood", "4 Iron", "5 Iron", "6 Iron", "7 Iron", "8 Iron", "9 Iron", "50°", "56°", "60°", "Putter"];
// Names only ever seeded by the old default list — presence of any of these means this
// install still has the pre-migration clubs and needs a one-time reseed onto the new list.
const LEGACY_ONLY_CLUB_NAMES = ["3 Wood", "PW", "GW", "SW", "LW"];

// Shots inside these pin distances are PARTIAL swings for these clubs, so they're reported as
// proximity rather than polluting full-swing distance averages.
//
// The 56°/50° values come straight from the spec. The 60° entry is a deliberate addition: the
// spec leaves every other club null, but a lob wedge is overwhelmingly a greenside club, and
// without a threshold every 20-yard chip counts as a "full swing 60°" — which reported the club
// as a 21-yard stick with HIGH confidence off a single sample round. A touch shot is not a full
// swing, and the spec's own intent (partials excluded from full-swing distances) requires this.
// All three remain user-editable in Settings.
const DEFAULT_PARTIAL_THRESHOLDS: Record<string, number> = { "56°": 80, "50°": 100, "60°": 60 };

export async function ensureDefaultClubs(): Promise<Club[]> {
  // Whole read-check-write runs as one Dexie transaction so two concurrent callers (e.g.
  // React StrictMode's dev-only double effect invocation) can't both see "empty"/"legacy"
  // and each seed their own duplicate batch — IndexedDB serializes same-store rw
  // transactions, so the second call sees the first's already-committed result.
  return db.transaction("rw", db.clubs, async () => {
    const existing = await db.clubs.toArray();
    const hasLegacy = existing.some((c) => LEGACY_ONLY_CLUB_NAMES.includes(c.name));
    if (existing.length && !hasLegacy) {
      // Idempotent backfill of the partial-swing thresholds on already-seeded clubs. Null counts
      // as unset here, not as a deliberate choice: earlier seeds wrote null for every club, and
      // leaving the wedges that way let greenside chips masquerade as full swings. To genuinely
      // mean "never partial" for a scoring club, set it to 0 in Settings — no shot is inside
      // zero yards, and 0 is preserved here.
      let changed = false;
      for (const c of existing) {
        const threshold = DEFAULT_PARTIAL_THRESHOLDS[c.name];
        if (threshold !== undefined && c.fullSwingMinYards == null) {
          c.fullSwingMinYards = threshold;
          await db.clubs.put(c);
          changed = true;
        }
      }
      return changed ? db.clubs.toArray() : existing;
    }
    if (hasLegacy) await db.clubs.clear();

    const clubs: Club[] = DEFAULT_CLUB_NAMES.map((name, i) => ({
      id: uuid(),
      name,
      sortOrder: i,
      fullSwingMinYards: DEFAULT_PARTIAL_THRESHOLDS[name] ?? null,
      updatedAt: now()
    }));
    await db.clubs.bulkPut(clubs);
    return clubs;
  });
}

export async function listClubs(): Promise<Club[]> {
  return (await db.clubs.toArray()).sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Updates a club's manual dispersion / stats settings (Settings page club table). */
export async function updateClubDispersion(
  clubId: string,
  patch: Partial<
    Pick<Club, "manualFrontBackYards" | "manualLeftRightYards" | "useActualDispersion" | "descentAngleDeg" | "fullSwingMinYards">
  >
): Promise<void> {
  const club = await db.clubs.get(clubId);
  if (!club) return;
  const updated: Club = { ...club, ...patch, updatedAt: now() };
  await db.clubs.put(updated);
  await queueOutbox("clubs", "upsert", updated);
}

export async function saveCustomHazard(holeId: string, geometry: GeoJSON.Polygon): Promise<void> {
  const feature: HoleFeature = {
    id: uuid(),
    holeId,
    featureType: "hazard",
    geometry,
    zOrder: Z_ORDER["hazard"]
  };
  await db.holeFeatures.put(feature);
  await queueOutbox("holeFeatures", "upsert", feature);
}

export async function deleteHoleFeature(featureId: string): Promise<void> {
  await db.holeFeatures.delete(featureId);
  await queueOutbox("holeFeatures", "delete", { id: featureId });
}
