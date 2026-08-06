import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "./db";
import {
  createTeeBox,
  deleteCourse,
  getTeeBoxesForHole,
  getHolesForVersion,
  getLatestCourseVersion,
  listCourses,
  saveImportedCourse
} from "./courseRepo";
import type { ParsedCourse } from "./importOverpass";

/** Minimal two-hole parse result — enough to exercise versioning without a real Overpass file. */
function parsed(opts?: { name?: string; teeNames?: string[] }): ParsedCourse {
  const teeNames = opts?.teeNames ?? ["Blue"];
  return {
    name: opts?.name ?? "Legends of the Niagara",
    location: { lat: 43.0464, lng: -79.0342 },
    holes: [
      { number: 1, par: 4, parInferred: false, defaultYardage: 389 },
      { number: 2, par: 5, parInferred: false, defaultYardage: 511 }
    ],
    features: [],
    teeBoxes: teeNames.flatMap((name) =>
      [1, 2].map((holeNumber) => ({ holeNumber, name, location: { lat: 43.04 + holeNumber / 1000, lng: -79.03 } }))
    ),
    warnings: []
  };
}

async function teeNamesForHole(courseId: string, holeNumber: number): Promise<string[]> {
  const version = await getLatestCourseVersion(courseId);
  const holes = await getHolesForVersion(version!.id);
  const hole = holes.find((h) => h.number === holeNumber)!;
  return (await getTeeBoxesForHole(hole.id)).map((t) => t.name).sort();
}

beforeEach(async () => {
  await Promise.all([db.courses, db.courseVersions, db.holes, db.holeFeatures, db.teeBoxes, db.outbox].map((t) => t.clear()));
});

describe("saveImportedCourse", () => {
  it("takes the display name from opts.name, overriding the OSM boundary name", async () => {
    const { courseId } = await saveImportedCourse(parsed(), { slug: "usshers-creek", name: "Ussher's Creek" });
    const course = await db.courses.get(courseId);
    expect(course?.name).toBe("Ussher's Creek");
    expect(course?.slug).toBe("usshers-creek");
  });

  it("falls back to the parsed OSM name when no override is given", async () => {
    const { courseId } = await saveImportedCourse(parsed());
    const course = await db.courses.get(courseId);
    expect(course?.name).toBe("Legends of the Niagara");
    expect(course?.slug).toBe("legends-of-the-niagara");
  });

  it("re-import under the same slug adds a version rather than duplicating the course", async () => {
    const first = await saveImportedCourse(parsed(), { slug: "usshers-creek", name: "Ussher's Creek" });
    const second = await saveImportedCourse(parsed(), { slug: "usshers-creek", name: "Ussher's Creek" });
    expect(second.courseId).toBe(first.courseId);
    expect(await db.courses.count()).toBe(1);
    const versions = await db.courseVersions.where("courseId").equals(first.courseId).toArray();
    expect(versions.map((v) => v.versionNumber).sort()).toEqual([1, 2]);
  });

  // The behaviour Colin asked for: a re-import carrying tee-box information supersedes tee boxes
  // added by hand in the Course Editor. It falls out of copy-on-write versioning — the new version
  // gets fresh Hole rows, and tee boxes hang off holeId — but it's the kind of thing that would
  // silently regress if someone later "fixed" the editor to write against a stable hole key, so
  // it's pinned here.
  it("re-importing supersedes manually added tee boxes", async () => {
    const { courseId } = await saveImportedCourse(parsed({ teeNames: ["Blue"] }), {
      slug: "usshers-creek",
      name: "Ussher's Creek"
    });

    const v1 = await getLatestCourseVersion(courseId);
    const v1Hole1 = (await getHolesForVersion(v1!.id)).find((h) => h.number === 1)!;
    await createTeeBox(v1Hole1.id, "White (manual)", { lat: 43.041, lng: -79.031 });
    expect(await teeNamesForHole(courseId, 1)).toEqual(["Blue", "White (manual)"]);

    await saveImportedCourse(parsed({ teeNames: ["Blue", "White"] }), { slug: "usshers-creek", name: "Ussher's Creek" });

    // Latest version reflects the upload only — the hand-added tee is gone from what the app reads.
    expect(await teeNamesForHole(courseId, 1)).toEqual(["Blue", "White"]);

    // ...and the superseded rows are still on the OLD version, so historical rounds played against
    // v1 keep resolving the geometry they were actually played on.
    expect((await getTeeBoxesForHole(v1Hole1.id)).map((t) => t.name).sort()).toEqual(["Blue", "White (manual)"]);
  });
});

describe("deleteCourse", () => {
  it("hides the course from the list without destroying its version chain", async () => {
    const { courseId, courseVersionId } = await saveImportedCourse(parsed(), {
      slug: "legends-of-the-niagara"
    });
    expect((await listCourses()).map((c) => c.slug)).toContain("legends-of-the-niagara");

    await deleteCourse(courseId);

    expect((await listCourses()).map((c) => c.slug)).not.toContain("legends-of-the-niagara");
    expect((await db.courses.get(courseId))?.deletedAt).toBeTruthy();
    // The version/hole rows survive, so rounds played against them still resolve.
    expect(await db.courseVersions.get(courseVersionId)).toBeTruthy();
    expect((await getHolesForVersion(courseVersionId)).length).toBe(2);
  });

  it("leaves other courses alone", async () => {
    const a = await saveImportedCourse(parsed(), { slug: "course-a", name: "A" });
    await saveImportedCourse(parsed(), { slug: "course-b", name: "B" });
    await deleteCourse(a.courseId);
    expect((await listCourses()).map((c) => c.slug)).toEqual(["course-b"]);
  });

  it("is idempotent", async () => {
    const { courseId } = await saveImportedCourse(parsed(), { slug: "usshers-creek" });
    await deleteCourse(courseId);
    const firstStamp = (await db.courses.get(courseId))?.deletedAt;
    await deleteCourse(courseId);
    expect((await db.courses.get(courseId))?.deletedAt).toBe(firstStamp);
  });

  // The only undo — without it a soft-deleted course is unreachable forever, since nothing else
  // clears deletedAt and there's no "show deleted" UI.
  it("re-importing the same slug brings a deleted course back", async () => {
    const { courseId } = await saveImportedCourse(parsed(), { slug: "usshers-creek", name: "Ussher's Creek" });
    await deleteCourse(courseId);
    expect(await listCourses()).toHaveLength(0);

    const again = await saveImportedCourse(parsed(), { slug: "usshers-creek", name: "Ussher's Creek" });

    expect(again.courseId).toBe(courseId);
    expect((await db.courses.get(courseId))?.deletedAt).toBeNull();
    expect((await listCourses()).map((c) => c.name)).toEqual(["Ussher's Creek"]);
  });
});
