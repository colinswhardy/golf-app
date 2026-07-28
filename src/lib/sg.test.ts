import { describe, expect, it } from "vitest";
import { interpolateExpectedStrokes } from "./sg";
import type { SgBaselineScratch } from "../types/domain";

const ROWS: SgBaselineScratch[] = [
  { lie: "fairway", distanceYards: 100, expectedStrokes: 2.8 },
  { lie: "fairway", distanceYards: 150, expectedStrokes: 3.0 },
  { lie: "fairway", distanceYards: 200, expectedStrokes: 3.2 },
  { lie: "green", distanceYards: 3, expectedStrokes: 1.0 },
  { lie: "green", distanceYards: 30, expectedStrokes: 2.0 }
];

describe("interpolateExpectedStrokes (5.6)", () => {
  it("interpolates linearly between bracketing rows", () => {
    expect(interpolateExpectedStrokes(ROWS, "fairway", 125)).toBeCloseTo(2.9, 5);
    expect(interpolateExpectedStrokes(ROWS, "green", 16.5)).toBeCloseTo(1.5, 5);
  });

  it("clamps outside the table range", () => {
    expect(interpolateExpectedStrokes(ROWS, "fairway", 50)).toBe(2.8);
    expect(interpolateExpectedStrokes(ROWS, "fairway", 300)).toBe(3.2);
  });

  it("null for a lie with no rows — the lie decides the category, never the club", () => {
    expect(interpolateExpectedStrokes(ROWS, "rough", 150)).toBeNull();
  });
});
