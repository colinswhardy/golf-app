import { describe, expect, it } from "vitest";
import {
  bearingDegrees,
  computeDispersionEllipse,
  distanceMeters,
  distanceYards,
  fromDownrangeOffline,
  fromLocalMeters,
  nearestPointOnSegment,
  toDownrangeOffline,
  toLocalMeters
} from "./geo";
import type { LatLng } from "../types/domain";

const ORIGIN: LatLng = { lat: 43.5, lng: -80.2 };

describe("distance", () => {
  it("is zero for identical points", () => {
    expect(distanceMeters(ORIGIN, ORIGIN)).toBe(0);
  });

  it("matches the ~111.2km/degree latitude rule", () => {
    const oneDegreeNorth = { lat: 44.5, lng: -80.2 };
    expect(distanceMeters(ORIGIN, oneDegreeNorth)).toBeCloseTo(111195, -3); // within ~1km
  });

  it("converts to yards", () => {
    const p = fromLocalMeters(ORIGIN, 0, 91.44); // 100 yards north
    expect(distanceYards(ORIGIN, p)).toBeCloseTo(100, 1);
  });
});

describe("bearingDegrees", () => {
  it("points north/east/south/west", () => {
    expect(bearingDegrees(ORIGIN, fromLocalMeters(ORIGIN, 0, 100))).toBeCloseTo(0, 1);
    expect(bearingDegrees(ORIGIN, fromLocalMeters(ORIGIN, 100, 0))).toBeCloseTo(90, 1);
    expect(bearingDegrees(ORIGIN, fromLocalMeters(ORIGIN, 0, -100))).toBeCloseTo(180, 1);
    expect(bearingDegrees(ORIGIN, fromLocalMeters(ORIGIN, -100, 0))).toBeCloseTo(270, 1);
  });
});

describe("local meters round-trip", () => {
  it("toLocalMeters inverts fromLocalMeters at golf scale", () => {
    const p = fromLocalMeters(ORIGIN, 123.4, -321.9);
    const { east, north } = toLocalMeters(ORIGIN, p);
    expect(east).toBeCloseTo(123.4, 3);
    expect(north).toBeCloseTo(-321.9, 3);
  });
});

describe("downrange/offline frame", () => {
  it("a point straight down the line is all downrange, no offline", () => {
    const target = fromLocalMeters(ORIGIN, 100, 100); // bearing 45
    const bearing = bearingDegrees(ORIGIN, target);
    const { downrangeYards, offlineYards } = toDownrangeOffline(ORIGIN, bearing, target);
    expect(offlineYards).toBeCloseTo(0, 1);
    expect(downrangeYards).toBeCloseTo(distanceYards(ORIGIN, target), 1);
  });

  it("right of the line is positive offline", () => {
    const bearing = 0; // aiming due north
    const right = fromLocalMeters(ORIGIN, 30, 100); // east of the line
    expect(toDownrangeOffline(ORIGIN, bearing, right).offlineYards).toBeGreaterThan(0);
    const left = fromLocalMeters(ORIGIN, -30, 100);
    expect(toDownrangeOffline(ORIGIN, bearing, left).offlineYards).toBeLessThan(0);
  });

  it("fromDownrangeOffline inverts toDownrangeOffline", () => {
    const bearing = 137;
    const p = fromDownrangeOffline(ORIGIN, bearing, 231, -18);
    const back = toDownrangeOffline(ORIGIN, bearing, p);
    expect(back.downrangeYards).toBeCloseTo(231, 1);
    expect(back.offlineYards).toBeCloseTo(-18, 1);
  });
});

describe("nearestPointOnSegment", () => {
  it("projects onto the middle of a segment", () => {
    const a = ORIGIN;
    const b = fromLocalMeters(ORIGIN, 0, 200);
    const p = fromLocalMeters(ORIGIN, 50, 100); // beside the midpoint
    const { point, distanceMeters: d } = nearestPointOnSegment(a, b, p);
    expect(d).toBeCloseTo(50, 0);
    const local = toLocalMeters(ORIGIN, point);
    expect(local.north).toBeCloseTo(100, 0);
    expect(local.east).toBeCloseTo(0, 0);
  });

  it("clamps to the segment ends", () => {
    const a = ORIGIN;
    const b = fromLocalMeters(ORIGIN, 0, 100);
    const beyond = fromLocalMeters(ORIGIN, 0, 250);
    const { point } = nearestPointOnSegment(a, b, beyond);
    expect(toLocalMeters(ORIGIN, point).north).toBeCloseTo(100, 0);
  });
});

describe("computeDispersionEllipse", () => {
  it("returns null under 3 points", () => {
    expect(computeDispersionEllipse([])).toBeNull();
    expect(
      computeDispersionEllipse([
        { downrangeYards: 100, offlineYards: 0 },
        { downrangeYards: 110, offlineYards: 2 }
      ])
    ).toBeNull();
  });

  it("centers on the mean and orients the long axis along the bigger spread", () => {
    const points = [
      { downrangeYards: 90, offlineYards: -2 },
      { downrangeYards: 100, offlineYards: 0 },
      { downrangeYards: 110, offlineYards: 2 },
      { downrangeYards: 95, offlineYards: 1 },
      { downrangeYards: 105, offlineYards: -1 }
    ];
    const e = computeDispersionEllipse(points, 0.9)!;
    expect(e.centerDownrange).toBeCloseTo(100, 5);
    expect(e.centerOffline).toBeCloseTo(0, 5);
    expect(e.semiMajor).toBeGreaterThan(e.semiMinor);
    expect(e.sampleSize).toBe(5);
  });
});
