import { describe, expect, it } from "vitest";
import {
  bucketForIntendedYards,
  classifyAssignedSwing,
  computeClubDistances,
  confidence,
  countTier,
  descentAngleDeg,
  flatEquivalentYards,
  findPutter,
  isEligibleForClubStats,
  isPutter,
  madOutlierIndices,
  median,
  percentile,
  spreadTier
} from "./stats";
import { fromLocalMeters } from "./geo";
import type { Club, LatLng, Shot } from "../types/domain";

const O: LatLng = { lat: 43.5, lng: -80.2 };

function mkClub(overrides: Partial<Club> = {}): Club {
  return { id: "7i", name: "7 Iron", sortOrder: 0, updatedAt: "", ...overrides };
}

function mkShot(overrides: Partial<Shot> = {}): Shot {
  return {
    id: Math.random().toString(36).slice(2),
    roundHoleId: "rh1",
    shotNumber: 1,
    clubId: "7i",
    startPoint: O,
    endPoint: fromLocalMeters(O, 0, 150),
    positionSource: "watch_lap",
    accuracyM: null,
    lieStart: "fairway",
    lieEnd: "green",
    watchLapId: null,
    clubTapId: null,
    reconciliation: "matched",
    elevationM: null,
    targetPoint: null,
    targetSource: "default_green",
    swingType: "full",
    intendedYards: null,
    penaltyType: null,
    excluded: null,
    exclusionNote: null,
    recordedAt: "2026-07-28T14:00:00Z",
    updatedAt: "",
    ...overrides
  };
}

describe("eligibility (5.1)", () => {
  it("accepts a clean shot and rejects each disqualifier", () => {
    expect(isEligibleForClubStats(mkShot())).toBe(true);
    expect(isEligibleForClubStats(mkShot({ clubId: null }))).toBe(false);
    expect(isEligibleForClubStats(mkShot({ swingType: "putt" }))).toBe(false);
    expect(isEligibleForClubStats(mkShot({ excluded: "manual" }))).toBe(false);
    expect(isEligibleForClubStats(mkShot({ positionSource: "tee_fallback" }))).toBe(false);
    expect(isEligibleForClubStats(mkShot({ accuracyM: 16 }))).toBe(false);
    expect(isEligibleForClubStats(mkShot({ accuracyM: 15 }))).toBe(true);
    expect(isEligibleForClubStats(mkShot({ endPoint: null }))).toBe(false);
    expect(isEligibleForClubStats(mkShot({ penaltyType: "ob" }))).toBe(false);
  });
});

describe("elevation normalisation (5.2)", () => {
  it("downhill shots lose the elevation bonus", () => {
    // 10m drop with a 47° descent: extra = (10 / 0.9144) / tan(47°) ≈ 10.2y
    const flat = flatEquivalentYards(160, 10, 47);
    expect(flat).toBeLessThan(160);
    expect(160 - flat).toBeCloseTo(10.2, 0);
  });

  it("uphill shots gain it back", () => {
    expect(flatEquivalentYards(150, -10, 47)).toBeGreaterThan(150);
  });

  it("a zero descent angle cannot produce a non-finite distance", () => {
    // 0 was typeable in the Settings field and divides by tan(0) — it returned -Infinity, which
    // NaN'd out the club's whole row. Clamped, so the correction stays finite and sane.
    expect(Number.isFinite(flatEquivalentYards(160, 10, 0))).toBe(true);
    expect(Number.isFinite(flatEquivalentYards(160, 0, 0))).toBe(true);
    expect(flatEquivalentYards(160, 10, 0)).toBeLessThan(160);
    expect(descentAngleDeg(mkClub({ descentAngleDeg: 0 }))).toBeGreaterThanOrEqual(10);
    expect(descentAngleDeg(mkClub({ descentAngleDeg: 500 }))).toBeLessThanOrEqual(80);
  });

  it("descent angle defaults follow the club-type table, overridable per club", () => {
    expect(descentAngleDeg(mkClub({ name: "Driver" }))).toBe(38);
    expect(descentAngleDeg(mkClub({ name: "5 Iron" }))).toBe(43);
    expect(descentAngleDeg(mkClub({ name: "7 Iron" }))).toBe(47);
    expect(descentAngleDeg(mkClub({ name: "50°" }))).toBe(51);
    expect(descentAngleDeg(mkClub({ name: "60°" }))).toBe(54);
    expect(descentAngleDeg(mkClub({ name: "7 Iron", descentAngleDeg: 49.5 }))).toBe(49.5);
  });
});

describe("identifying the putter (the bag is user-editable)", () => {
  it("recognises a renamed putter, not just the exact default name", () => {
    expect(isPutter({ name: "Putter" })).toBe(true);
    expect(isPutter({ name: "putter" })).toBe(true);
    expect(isPutter({ name: "Odyssey Putter" })).toBe(true);
    expect(isPutter({ name: "Scotty Cameron putter" })).toBe(true);
    expect(isPutter({ name: "7 Iron" })).toBe(false);
    expect(isPutter({ name: "Pitching Wedge" })).toBe(false);
  });

  it("finds it in a bag, and reports null when there isn't one", () => {
    expect(findPutter([{ name: "Driver" }, { name: "Odyssey Putter" }])?.name).toBe("Odyssey Putter");
    expect(findPutter([{ name: "Driver" }, { name: "7 Iron" }])).toBeNull();
  });

  it("keeps a renamed putter out of full-swing club distances", () => {
    const putter = mkClub({ id: "p", name: "Odyssey #7 Putter" });
    // Even given full-swing rows, a club identified as the putter is never distance-summarised.
    const shots = [1, 2, 3, 4, 5].map(() =>
      mkShot({ clubId: "p", swingType: "full", endPoint: fromLocalMeters(O, 0, 9) })
    );
    expect(computeClubDistances(shots, [putter])).toHaveLength(0);
  });
});

describe("robust stats (5.3)", () => {
  it("median and percentile interpolate", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50], 80)).toBeCloseTo(42, 5);
  });

  it("MAD rejects the short mishit but not the normal spread", () => {
    const values = [148, 150, 152, 155, 149, 151, 100]; // one chunk
    const out = madOutlierIndices(values);
    expect(out.has(6)).toBe(true);
    expect(out.size).toBe(1);
  });

  it("mad === 0 (identical values) excludes nothing", () => {
    expect(madOutlierIndices([150, 150, 150, 150]).size).toBe(0);
  });

  it("under 4 values excludes nothing", () => {
    expect(madOutlierIndices([100, 200, 300]).size).toBe(0);
  });

  it("confidence tiers per spec, taking the lower of count and spread", () => {
    expect(countTier(3)).toBe("none");
    expect(countTier(4)).toBe("low");
    expect(countTier(10)).toBe("medium");
    expect(countTier(15)).toBe("high");
    expect(countTier(20)).toBe("confident");
    expect(spreadTier(26)).toBe("low");
    expect(spreadTier(20)).toBe("medium");
    expect(spreadTier(10)).toBe("high");
    expect(spreadTier(7)).toBe("confident");
    expect(confidence(20, 26)).toBe("low"); // plenty of shots, huge spread
    expect(confidence(5, 5)).toBe("low"); // tight spread, few shots
  });
});

describe("computeClubDistances (5.3)", () => {
  it("reports typical/flushed, flags outliers, and never counts putts or tee fallbacks", () => {
    const club = mkClub();
    const mkAt = (yards: number, over: Partial<Shot> = {}) =>
      mkShot({ endPoint: fromLocalMeters(O, 0, yards * 0.9144), ...over });
    const shots = [
      mkAt(148),
      mkAt(150),
      mkAt(152),
      mkAt(155),
      mkAt(149),
      mkAt(151),
      mkAt(100), // chunk — should be MAD-flagged
      mkAt(150, { swingType: "putt" }),
      mkAt(150, { positionSource: "tee_fallback" })
    ];
    const [summary] = computeClubDistances(shots, [club]);
    expect(summary.count).toBe(6); // 7 eligible full swings minus the outlier
    expect(summary.typicalYards).toBeGreaterThan(148);
    expect(summary.typicalYards).toBeLessThan(153);
    expect(summary.flushedYards!).toBeGreaterThanOrEqual(summary.typicalYards!);
    expect(summary.autoOutlierShotIds).toHaveLength(1);
  });

  it("re-includes a previously flagged outlier when it stops being one", () => {
    const club = mkClub();
    const flagged = mkShot({ endPoint: fromLocalMeters(O, 0, 150 * 0.9144), excluded: "auto_outlier" });
    const shots = [
      flagged,
      mkShot({ endPoint: fromLocalMeters(O, 0, 149 * 0.9144) }),
      mkShot({ endPoint: fromLocalMeters(O, 0, 151 * 0.9144) }),
      mkShot({ endPoint: fromLocalMeters(O, 0, 152 * 0.9144) })
    ];
    const [summary] = computeClubDistances(shots, [club]);
    expect(summary.clearOutlierShotIds).toContain(flagged.id);
  });
});

describe("partial bucketing (5.4)", () => {
  it("buckets on intended distance, rounded to 10s, clamped 30–80", () => {
    expect(bucketForIntendedYards(52)).toBe(50);
    expect(bucketForIntendedYards(55)).toBe(60);
    expect(bucketForIntendedYards(12)).toBe(30);
    expect(bucketForIntendedYards(95)).toBe(80);
  });
});

describe("classifyAssignedSwing — post-round club assignment mirrors reconciliation", () => {
  const wedge = mkClub({ id: "sw", name: "56°", fullSwingMinYards: 80 });
  const putter = mkClub({ id: "p", name: "Putter" });

  it("the putter, or any stroke off the green, is a putt", () => {
    expect(classifyAssignedSwing(putter, "p", "fringe", 5).swingType).toBe("putt");
    expect(classifyAssignedSwing(wedge, "p", "green", 20).swingType).toBe("putt");
    expect(classifyAssignedSwing(null, "p", "green", null).swingType).toBe("putt");
  });

  it("a known club inside its full-swing floor is a partial with intendedYards set", () => {
    expect(classifyAssignedSwing(wedge, "p", "rough", 45)).toEqual({ swingType: "partial", intendedYards: 45 });
  });

  it("outside the floor, with no floor, or with no pin distance, it's a full swing", () => {
    expect(classifyAssignedSwing(wedge, "p", "fairway", 95).swingType).toBe("full");
    expect(classifyAssignedSwing(mkClub(), "p", "fairway", 45).swingType).toBe("full");
    expect(classifyAssignedSwing(wedge, "p", "fairway", null).swingType).toBe("full");
  });

  it("an unknown club stays a plain full swing", () => {
    expect(classifyAssignedSwing(null, "p", "rough", 30)).toEqual({ swingType: "full", intendedYards: null });
  });
});
