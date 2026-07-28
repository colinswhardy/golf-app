import { describe, expect, it } from "vitest";
import { reconcile, type ReconcileHoleInput, type ReconcileInput } from "./reconcile";
import { distanceMeters, fromLocalMeters } from "./geo";
import { encodeTrack } from "./track";
import type { Club, ClubTap, LatLng, Shot, WatchLap } from "../types/domain";

// ---------------------------------------------------------------------------
// Fixture: two parallel holes running opposite directions (hole 2's fairway is
// metres from hole 1's — the Appendix A case 7 trap), local-metres layout.
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-07-28T14:00:00Z");
const O: LatLng = { lat: 43.5, lng: -80.2 };
const pt = (east: number, north: number) => fromLocalMeters(O, east, north);

function rect(eMin: number, eMax: number, nMin: number, nMax: number): GeoJSON.Polygon {
  const c = [pt(eMin, nMin), pt(eMax, nMin), pt(eMax, nMax), pt(eMin, nMax), pt(eMin, nMin)];
  return { type: "Polygon", coordinates: [c.map((p) => [p.lng, p.lat])] };
}

const HOLE1: ReconcileHoleInput = {
  roundHoleId: "rh1",
  holeId: "h1",
  number: 1,
  par: 4,
  score: null,
  teeLocation: pt(0, 0),
  pin: pt(0, 355),
  features: [
    { featureType: "tee", geometry: rect(-10, 10, -10, 10), zOrder: 2 },
    { featureType: "fairway", geometry: rect(-30, 30, 100, 300), zOrder: 1 },
    { featureType: "green", geometry: rect(-15, 15, 340, 380), zOrder: 3 }
  ]
};

// Parallel, runs south (tee up by hole 1's green, green back near hole 1's tee).
const HOLE2: ReconcileHoleInput = {
  roundHoleId: "rh2",
  holeId: "h2",
  number: 2,
  par: 4,
  score: null,
  teeLocation: pt(60, 360),
  pin: pt(60, -5),
  features: [
    { featureType: "tee", geometry: rect(50, 70, 350, 370), zOrder: 2 },
    { featureType: "fairway", geometry: rect(40, 100, 60, 320), zOrder: 1 },
    { featureType: "green", geometry: rect(45, 75, -20, 10), zOrder: 3 }
  ]
};

const CLUBS: Club[] = [
  { id: "driver", name: "Driver", sortOrder: 0, updatedAt: "" },
  { id: "5i", name: "5 Iron", sortOrder: 1, updatedAt: "" },
  { id: "4i", name: "4 Iron", sortOrder: 2, updatedAt: "" },
  { id: "7i", name: "7 Iron", sortOrder: 3, updatedAt: "" },
  { id: "56", name: "56°", sortOrder: 4, fullSwingMinYards: 80, updatedAt: "" },
  { id: "putter", name: "Putter", sortOrder: 5, updatedAt: "" }
];

let ids = 0;
const nid = () => `id${++ids}`;

function lap(tSec: number, point: LatLng, lapIndex: number): WatchLap {
  return {
    id: nid(),
    roundId: "r1",
    lapIndex,
    tWatch: new Date(T0 + tSec * 1000).toISOString(),
    point,
    elevationM: null,
    matchedShotId: null
  };
}

/** Phone-clock tap. `phoneOffsetSec` shifts the phone clock relative to the watch clock. */
function tap(tSec: number, clubId: string, phoneOffsetSec = 0): ClubTap {
  return {
    id: nid(),
    roundId: "r1",
    tPhone: new Date(T0 + (tSec - phoneOffsetSec) * 1000).toISOString(),
    clubId,
    serialNumber: `serial-${clubId}`,
    point: null,
    accuracyM: null,
    matchedShotId: null
  };
}

function greenPutt(roundHoleId: string, start: LatLng, end: LatLng, shotNumber: number): Shot {
  return {
    id: nid(),
    roundHoleId,
    shotNumber,
    clubId: "putter",
    startPoint: start,
    endPoint: end,
    positionSource: "manual",
    accuracyM: null,
    lieStart: "green",
    lieEnd: "green",
    watchLapId: null,
    clubTapId: null,
    reconciliation: "green_mark",
    elevationM: null,
    targetPoint: null,
    targetSource: "default_pin",
    swingType: "putt",
    intendedYards: null,
    penaltyType: null,
    excluded: null,
    exclusionNote: null,
    recordedAt: new Date(T0 + 2000 * 1000).toISOString(),
    updatedAt: "",
    userEdited: false
  };
}

function run(partial: Partial<ReconcileInput>): ReturnType<typeof reconcile> {
  return reconcile({
    laps: [],
    track: null,
    taps: [],
    holes: [HOLE1],
    existingShots: [],
    clubs: CLUBS,
    clockOffsetMs: null,
    calibrationPhoneTime: null,
    ...partial
  });
}

const swings = (r: ReturnType<typeof reconcile>) => r.shots.filter((s) => s.swingType !== "putt" && s.penaltyType === null);

describe("reconcile — Appendix A", () => {
  // Case 1
  it("clean hole: 4 laps + 4 taps all match, chain and distances correct", () => {
    const laps = [lap(0, pt(0, 0), 0), lap(300, pt(0, 240), 1), lap(600, pt(0, 330), 2), lap(900, pt(0, 355), 3)];
    const taps = [tap(-5, "driver"), tap(295, "5i"), tap(595, "56"), tap(895, "putter")];
    const r = run({ laps, taps });

    expect(r.shots).toHaveLength(4);
    expect(r.shots.every((s) => s.reconciliation === "matched")).toBe(true);
    expect(r.shots.map((s) => s.clubId)).toEqual(["driver", "5i", "56", "putter"]);
    expect(r.flags.filter((f) => f.type === "missing_club" || f.type === "unmatched_tap")).toHaveLength(0);

    // Chaining: each shot ends where the next begins; last ends at the pin.
    for (let i = 0; i < 3; i++) {
      expect(r.shots[i].endPoint).toEqual(r.shots[i + 1].startPoint);
    }
    expect(r.shots[3].endPoint).toEqual(HOLE1.pin);
    // Distance sanity: shot 1 travelled 240m.
    expect(distanceMeters(r.shots[0].startPoint, r.shots[0].endPoint!)).toBeCloseTo(240, 0);
    // Lies derived from geometry: tee, then fairway, then fairway/green edgeish, then green.
    expect(r.shots[0].lieStart).toBe("tee");
    expect(r.shots[1].lieStart).toBe("fairway");
    expect(r.shots[3].lieStart).toBe("green");
  });

  // Case 2
  it("tap AFTER the swing still matches", () => {
    const laps = [lap(0, pt(0, 0), 0)];
    const taps = [tap(40, "driver")];
    const r = run({ laps, taps });
    expect(r.shots).toHaveLength(1);
    expect(r.shots[0].reconciliation).toBe("matched");
    expect(r.shots[0].clubId).toBe("driver");
  });

  // Case 3
  it("club change: two taps 8s apart with no lap between → later tap wins", () => {
    const laps = [lap(100, pt(0, 0), 0)];
    const taps = [tap(90, "5i"), tap(98, "4i")];
    const r = run({ laps, taps });
    expect(r.shots).toHaveLength(1);
    expect(r.shots[0].clubId).toBe("4i");
    // The discarded 5i tap must NOT surface as an unmatched-tap shot or flag.
    expect(r.flags.filter((f) => f.type === "unmatched_tap")).toHaveLength(0);
  });

  // Case 4
  it("forgotten tap: 4 laps, 3 taps → one lap_only shot + missing_club flag", () => {
    const laps = [lap(0, pt(0, 0), 0), lap(300, pt(0, 240), 1), lap(600, pt(0, 330), 2), lap(900, pt(0, 355), 3)];
    const taps = [tap(-5, "driver"), tap(295, "5i"), tap(895, "putter")]; // no tap for lap 3
    const r = run({ laps, taps });

    expect(r.shots).toHaveLength(4);
    const lapOnly = r.shots.filter((s) => s.reconciliation === "lap_only");
    expect(lapOnly).toHaveLength(1);
    expect(lapOnly[0].clubId).toBeNull();
    expect(lapOnly[0].positionSource).toBe("watch_lap");
    const flags = r.flags.filter((f) => f.type === "missing_club");
    expect(flags).toHaveLength(1);
    expect(flags[0].shotId).toBe(lapOnly[0].id);
  });

  // Case 5
  it("forgotten lap: 3 laps, 4 taps → one tap_only shot positioned from the track + flag", () => {
    const laps = [lap(0, pt(0, 0), 0), lap(600, pt(0, 330), 1), lap(900, pt(0, 355), 2)];
    const taps = [tap(-5, "driver"), tap(295, "5i"), tap(595, "56"), tap(895, "putter")];
    // 1 Hz track parked at (0, 240) around the forgotten lap's moment.
    const samples = [];
    for (let t = -100; t <= 1000; t += 1) {
      samples.push({ t: T0 + t * 1000, point: pt(0, 240), elevationM: 300 });
    }
    const track = encodeTrack("r1", samples);
    const r = run({ laps, taps, track });

    expect(swings(r)).toHaveLength(4);
    const tapOnly = r.shots.filter((s) => s.reconciliation === "tap_only");
    expect(tapOnly).toHaveLength(1);
    expect(tapOnly[0].clubId).toBe("5i");
    expect(tapOnly[0].positionSource).toBe("watch_track");
    expect(distanceMeters(tapOnly[0].startPoint, pt(0, 240))).toBeLessThan(2);
    expect(r.flags.filter((f) => f.type === "unmatched_tap")).toHaveLength(1);
  });

  // Case 6
  it("a +7s clock offset is estimated and matching still succeeds", () => {
    const laps = [lap(0, pt(0, 0), 0), lap(300, pt(0, 240), 1), lap(600, pt(0, 330), 2)];
    // Phone clock runs 7s behind the watch: identical true moments, shifted timestamps.
    const taps = [tap(0, "driver", 7), tap(300, "5i", 7), tap(600, "56", 7)];
    const r = run({ laps, taps });

    expect(r.clockOffsetMethod).toBe("estimated");
    expect(Math.abs(r.clockOffsetMs - 7000)).toBeLessThanOrEqual(1500);
    expect(r.shots).toHaveLength(3);
    expect(r.shots.every((s) => s.reconciliation === "matched")).toBe(true);
  });

  // Case 7
  it("parallel holes: a lap inside the adjacent hole's fairway is assigned by SEQUENCE", () => {
    // Playing hole 1; the second shot drifts right, physically inside hole 2's fairway.
    const strayPoint = pt(55, 200); // inside HOLE2's fairway rect(40..100, 60..320)
    const laps = [lap(0, pt(0, 0), 0), lap(300, strayPoint, 1), lap(600, pt(0, 355), 2)];
    const r = run({ laps, taps: [], holes: [HOLE1, HOLE2] });

    const stray = r.shots.find((s) => distanceMeters(s.startPoint, strayPoint) < 1)!;
    expect(stray.roundHoleId).toBe("rh1"); // NOT rh2, despite geometric containment
  });

  // Case 8
  it("score mismatch: 4 swings + 2 putts + 0 penalties vs a score of 7 → flag", () => {
    const hole = { ...HOLE1, score: 7 };
    const laps = [lap(0, pt(0, 0), 0), lap(300, pt(0, 240), 1), lap(600, pt(0, 300), 2), lap(900, pt(0, 340), 3)];
    const taps = [tap(-5, "driver"), tap(295, "5i"), tap(595, "56"), tap(895, "7i")];
    const putts = [greenPutt("rh1", pt(0, 350), pt(0, 353), 5), greenPutt("rh1", pt(0, 353), pt(0, 355), 6)];
    const r = run({ laps, taps, holes: [hole], existingShots: putts });

    const flags = r.flags.filter((f) => f.type === "score_mismatch");
    expect(flags).toHaveLength(1);
    expect(flags[0].detail).toContain("7");
    expect(flags[0].detail).toContain("6"); // 4 + 2 + 0
  });

  // Case 9
  it("chip-in: pin marked, zero putts — last swing holes out at the pin", () => {
    const laps = [lap(0, pt(0, 0), 0), lap(300, pt(0, 330), 1)];
    const taps = [tap(-5, "driver"), tap(295, "56")];
    const r = run({ laps, taps });

    expect(r.shots).toHaveLength(2);
    expect(r.shots[1].endPoint).toEqual(HOLE1.pin);
    expect(r.shots[1].lieEnd).toBe("green");
    expect(r.shots.filter((s) => s.swingType === "putt")).toHaveLength(0);
  });

  // Case 10
  it("re-running after a manual club correction preserves the correction (and ids)", () => {
    const laps = [lap(0, pt(0, 0), 0), lap(300, pt(0, 240), 1), lap(600, pt(0, 355), 2)];
    const taps = [tap(-5, "driver"), tap(295, "5i"), tap(595, "putter")];
    const first = run({ laps, taps });
    expect(first.shots).toHaveLength(3);

    // User corrects shot 2's club: 5i was actually a 4i.
    const corrected = first.shots.map((s) =>
      s.shotNumber === 2 ? { ...s, clubId: "4i", userEdited: true } : s
    );
    const second = run({ laps, taps, existingShots: corrected });

    expect(second.shots).toHaveLength(3);
    const shot2 = second.shots.find((s) => s.shotNumber === 2)!;
    expect(shot2.clubId).toBe("4i");
    expect(shot2.userEdited).toBe(true);
    // Untouched rows keep their identity — nothing deleted, ids stable.
    expect(second.deleteShotIds).toHaveLength(0);
    const firstIds = new Set(first.shots.map((s) => s.id));
    expect(second.shots.every((s) => firstIds.has(s.id))).toBe(true);
  });
});
