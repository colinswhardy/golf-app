import { describe, expect, it } from "vitest";
import { defaultTargetForShot, type TargetContext } from "./targets";
import { distanceYards, fromLocalMeters } from "./geo";
import type { LatLng } from "../types/domain";

const TEE: LatLng = { lat: 43.5, lng: -80.2 };
const GREEN = fromLocalMeters(TEE, 0, 380);
const PIN = fromLocalMeters(TEE, 3, 378);

// Straight north centerline, ~415y long.
const CENTERLINE: GeoJSON.LineString = {
  type: "LineString",
  coordinates: [
    [TEE.lng, TEE.lat],
    [GREEN.lng, GREEN.lat]
  ]
};

function ctx(overrides: Partial<TargetContext> = {}): TargetContext {
  return {
    par: 4,
    pin: PIN,
    greenCentroid: GREEN,
    teeLocation: TEE,
    centerline: CENTERLINE,
    clubMedianYards: () => 250,
    ...overrides
  };
}

describe("defaultTargetForShot (4.2)", () => {
  it("tee shot on a par 4 aims down the centerline at the club's median distance", () => {
    const t = defaultTargetForShot({ shotNumber: 1, swingType: "full", clubId: "driver" }, ctx())!;
    expect(t.source).toBe("default_fairway");
    expect(distanceYards(TEE, t.point)).toBeCloseTo(250, 0);
  });

  it("falls back to a fixed distance when the club has no median yet", () => {
    const t = defaultTargetForShot({ shotNumber: 1, swingType: "full", clubId: "driver" }, ctx({ clubMedianYards: () => null }))!;
    expect(t.source).toBe("default_fairway");
    expect(distanceYards(TEE, t.point)).toBeCloseTo(230, 0);
  });

  it("approach shots target the pin, or the green centroid without one", () => {
    const approach = { shotNumber: 2, swingType: "full" as const, clubId: "7i" };
    expect(defaultTargetForShot(approach, ctx())!).toEqual({ point: PIN, source: "default_pin" });
    expect(defaultTargetForShot(approach, ctx({ pin: null }))!).toEqual({ point: GREEN, source: "default_green" });
  });

  it("par-3 tee shots target the pin (no fairway to lay to)", () => {
    const t = defaultTargetForShot({ shotNumber: 1, swingType: "full", clubId: "7i" }, ctx({ par: 3 }))!;
    expect(t.source).toBe("default_pin");
  });

  it("putts target the pin; no pin, no default", () => {
    expect(defaultTargetForShot({ shotNumber: 4, swingType: "putt", clubId: "putter" }, ctx())!.source).toBe("default_pin");
    expect(defaultTargetForShot({ shotNumber: 4, swingType: "putt", clubId: "putter" }, ctx({ pin: null }))).toBeNull();
  });
});
