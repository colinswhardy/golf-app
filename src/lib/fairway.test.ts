import { describe, expect, it } from "vitest";
import { classifyFairwayResult } from "./fairway";
import { fromLocalMeters } from "./geo";
import type { LatLng } from "../types/domain";

// Hole laid out due north: tee at origin, green 360m (~394y) north.
// Fairway = a rectangle from 120m to 300m downrange, 30m either side of the line.
const TEE: LatLng = { lat: 43.5, lng: -80.2 };
const GREEN = fromLocalMeters(TEE, 0, 360);

function rect(eastMin: number, eastMax: number, northMin: number, northMax: number): GeoJSON.Polygon {
  const corners = [
    fromLocalMeters(TEE, eastMin, northMin),
    fromLocalMeters(TEE, eastMax, northMin),
    fromLocalMeters(TEE, eastMax, northMax),
    fromLocalMeters(TEE, eastMin, northMax),
    fromLocalMeters(TEE, eastMin, northMin)
  ];
  return { type: "Polygon", coordinates: [corners.map((c) => [c.lng, c.lat])] };
}

const FAIRWAY = rect(-30, 30, 120, 300);

describe("classifyFairwayResult", () => {
  it("inside the fairway polygon is a hit", () => {
    expect(classifyFairwayResult(FAIRWAY, TEE, GREEN, fromLocalMeters(TEE, 0, 200))).toBe("hit");
  });

  it("off to the right within the fairway's downrange span is right", () => {
    expect(classifyFairwayResult(FAIRWAY, TEE, GREEN, fromLocalMeters(TEE, 60, 200))).toBe("right");
  });

  it("off to the left is left", () => {
    expect(classifyFairwayResult(FAIRWAY, TEE, GREEN, fromLocalMeters(TEE, -60, 200))).toBe("left");
  });

  it("before the fairway starts is short", () => {
    expect(classifyFairwayResult(FAIRWAY, TEE, GREEN, fromLocalMeters(TEE, 0, 60))).toBe("short");
  });

  it("past the fairway's end is long", () => {
    expect(classifyFairwayResult(FAIRWAY, TEE, GREEN, fromLocalMeters(TEE, 10, 340))).toBe("long");
  });
});
