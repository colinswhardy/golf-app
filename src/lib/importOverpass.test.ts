import { describe, expect, it } from "vitest";
import { detectCourseNames, parseOverpassGeoJson } from "./importOverpass";

/** A hole line running north from (lng, latBase) with a green polygon at its far end, so the
 * geometric green->hole matching downstream has something real to attach to. */
function hole(ref: number, courseName: string | null, lngOffset: number): GeoJSON.Feature[] {
  const lng = -80 + lngOffset;
  const props: Record<string, unknown> = { "@id": `way/${ref}${lngOffset}`, golf: "hole", ref: String(ref), par: "4" };
  if (courseName) props["golf:course:name"] = courseName;
  const greenLat = 43.003;
  return [
    {
      type: "Feature",
      properties: props,
      geometry: { type: "LineString", coordinates: [[lng, 43.0], [lng, greenLat]] }
    },
    {
      type: "Feature",
      properties: { "@id": `way/g${ref}${lngOffset}`, golf: "green" },
      geometry: {
        type: "Polygon",
        coordinates: [[
          [lng - 0.0002, greenLat - 0.0002],
          [lng + 0.0002, greenLat - 0.0002],
          [lng + 0.0002, greenLat + 0.0002],
          [lng - 0.0002, greenLat + 0.0002],
          [lng - 0.0002, greenLat - 0.0002]
        ]]
      }
    }
  ];
}

const BOUNDARY: GeoJSON.Feature = {
  type: "Feature",
  properties: { "@id": "way/1", leisure: "golf_course", name: "Victoria Park Valley Golf Club" },
  geometry: {
    type: "Polygon",
    coordinates: [[[-80.01, 42.99], [-79.98, 42.99], [-79.98, 43.01], [-80.01, 43.01], [-80.01, 42.99]]]
  }
};

/** Three nines, each numbered 1..3 independently — the real Victoria Park Valley shape. */
function facility(): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      BOUNDARY,
      ...[1, 2, 3].flatMap((r) => hole(r, "Pines", r * 0.001)),
      ...[1, 2, 3].flatMap((r) => hole(r, "Lakes", 0.01 + r * 0.001)),
      ...[1, 2, 3].flatMap((r) => hole(r, "Valley", 0.02 + r * 0.001))
    ]
  };
}

describe("detectCourseNames", () => {
  it("lists each course once, in first-seen order", () => {
    expect(detectCourseNames(facility())).toEqual(["Pines", "Lakes", "Valley"]);
  });

  it("is empty for a single unnamed course", () => {
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [BOUNDARY, ...hole(1, null, 0.001)]
    };
    expect(detectCourseNames(fc)).toEqual([]);
  });
});

describe("multi-course facilities", () => {
  // The defect this exists to prevent: three nines all numbered 1..9 collapsing into one 9-hole
  // course silently assembled from all three.
  it("without a courseName, colliding refs are flagged rather than silently merged", () => {
    const p = parseOverpassGeoJson(facility());
    expect(p.holes).toHaveLength(3);
    const collision = p.warnings.find((w) => w.includes("appear more than once"));
    expect(collision).toBeTruthy();
    expect(collision).toContain("Pines, Lakes, Valley");
  });

  it("courseName selects one nine, and its greens come with it", () => {
    const p = parseOverpassGeoJson(facility(), { courseName: "Lakes" });
    expect(p.holes.map((h) => h.number)).toEqual([1, 2, 3]);
    expect(p.warnings.find((w) => w.includes("appear more than once"))).toBeUndefined();

    // One green per hole, and each must be the Lakes green — i.e. near the Lakes centerlines,
    // not a Pines or Valley one 0.01 degrees away.
    for (const n of [1, 2, 3]) {
      const greens = p.features.filter((f) => f.holeNumber === n && f.featureType === "green");
      expect(greens).toHaveLength(1);
      const lng = (greens[0].geometry as GeoJSON.Polygon).coordinates[0][0][0];
      expect(lng).toBeGreaterThan(-80 + 0.01);
      expect(lng).toBeLessThan(-80 + 0.02);
    }
  });

  it("each nine parses independently from the same file", () => {
    for (const nine of ["Pines", "Lakes", "Valley"]) {
      const p = parseOverpassGeoJson(facility(), { courseName: nine });
      expect(p.holes).toHaveLength(3);
      expect(p.features.filter((f) => f.featureType === "green")).toHaveLength(3);
    }
  });

  it("warns rather than silently returning an empty course when the name does not match", () => {
    const p = parseOverpassGeoJson(facility(), { courseName: "Pinez" });
    expect(p.warnings.some((w) => w.includes("golf:course:name"))).toBe(true);
  });

  it("a single-course file is unaffected when no courseName is given", () => {
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [BOUNDARY, ...hole(1, null, 0.001), ...hole(2, null, 0.002)]
    };
    const p = parseOverpassGeoJson(fc);
    expect(p.name).toBe("Victoria Park Valley Golf Club");
    expect(p.holes.map((h) => h.number)).toEqual([1, 2]);
    expect(p.warnings.find((w) => w.includes("appear more than once"))).toBeUndefined();
  });
});
