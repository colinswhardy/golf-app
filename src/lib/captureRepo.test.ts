import { describe, expect, it } from "vitest";
import { countCapturedSwings } from "./captureRepo";
import type { ClubTap, WatchLap } from "../types/domain";

const T0 = Date.parse("2026-07-29T14:00:00Z");

function lap(offsetSec: number): WatchLap {
  return {
    id: `lap${offsetSec}`,
    roundId: "r1",
    roundHoleId: "rh1",
    lapIndex: offsetSec,
    tWatch: new Date(T0 + offsetSec * 1000).toISOString(),
    point: { lat: 43.5, lng: -80.2 },
    elevationM: null,
    matchedShotId: null
  };
}

function tap(offsetSec: number, clubId = "7i"): ClubTap {
  return {
    id: `tap${offsetSec}-${clubId}`,
    roundId: "r1",
    roundHoleId: "rh1",
    tPhone: new Date(T0 + offsetSec * 1000).toISOString(),
    clubId,
    serialNumber: `serial-${clubId}`,
    point: null,
    accuracyM: null,
    matchedShotId: null
  };
}

describe("countCapturedSwings — live stroke count from the capture streams", () => {
  it("counts nothing before anything is captured", () => {
    expect(countCapturedSwings([], [])).toBe(0);
  });

  it("counts one swing per lap+tag pair", () => {
    const laps = [lap(0), lap(200), lap(400)];
    const taps = [tap(-8), tap(192), tap(392)];
    expect(countCapturedSwings(laps, taps)).toBe(3);
  });

  it("collapses a club change — two tags within 20s are one swing", () => {
    // Pulled a 5 iron, put it back, took the 4 iron, then hit it.
    const taps = [tap(0, "5i"), tap(8, "4i")];
    expect(countCapturedSwings([lap(20)], taps)).toBe(1);
  });

  it("does not collapse tags far enough apart to be separate shots", () => {
    expect(countCapturedSwings([], [tap(0), tap(120), tap(240)])).toBe(3);
  });

  it("falls back to tags when the watch recorded nothing", () => {
    expect(countCapturedSwings([], [tap(0), tap(200)])).toBe(2);
  });

  it("keeps the lap count when a tag was forgotten", () => {
    // Three swings, only two clubs tagged — the count must not drop to two.
    expect(countCapturedSwings([lap(0), lap(200), lap(400)], [tap(-8), tap(192)])).toBe(3);
  });

  it("keeps the tag count when a lap press was missed", () => {
    expect(countCapturedSwings([lap(0), lap(200)], [tap(-8), tap(192), tap(392)])).toBe(3);
  });
});
