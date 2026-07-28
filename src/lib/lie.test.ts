import { describe, expect, it } from "vitest";
import { detectLie } from "./lie";
import type { HoleFeature, LatLng } from "../types/domain";

// A tiny square polygon (~200m x 200m) around a center point, in lon/lat.
function square(center: LatLng, halfDeg = 0.001): GeoJSON.Polygon {
  const { lat, lng } = center;
  return {
    type: "Polygon",
    coordinates: [
      [
        [lng - halfDeg, lat - halfDeg],
        [lng + halfDeg, lat - halfDeg],
        [lng + halfDeg, lat + halfDeg],
        [lng - halfDeg, lat + halfDeg],
        [lng - halfDeg, lat - halfDeg]
      ]
    ]
  };
}

const C: LatLng = { lat: 43.5, lng: -80.2 };

function feature(featureType: HoleFeature["featureType"], geometry: HoleFeature["geometry"], zOrder: number): HoleFeature {
  return { id: featureType, holeId: "h1", featureType, geometry, zOrder };
}

describe("detectLie", () => {
  it("detects a point inside a polygon", () => {
    expect(detectLie(C, [feature("green", square(C), 3)])).toBe("green");
  });

  it("defaults to rough when nothing matches", () => {
    const far: LatLng = { lat: 43.6, lng: -80.3 };
    expect(detectLie(far, [feature("green", square(C), 3)])).toBe("rough");
  });

  it("higher z-order wins where polygons overlap (fringe beats green)", () => {
    const features = [feature("green", square(C), 3), feature("fringe", square(C), 4)];
    expect(detectLie(C, features)).toBe("fringe");
    // order in the array must not matter
    expect(detectLie(C, [...features].reverse())).toBe("fringe");
  });

  it("skips centerline LineStrings instead of throwing", () => {
    const centerline: HoleFeature = {
      id: "cl",
      holeId: "h1",
      featureType: "centerline",
      geometry: { type: "LineString", coordinates: [[C.lng, C.lat], [C.lng + 0.002, C.lat]] },
      zOrder: 0
    };
    expect(detectLie(C, [centerline, feature("fairway", square(C), 1)])).toBe("fairway");
    expect(detectLie(C, [centerline])).toBe("rough");
  });
});
