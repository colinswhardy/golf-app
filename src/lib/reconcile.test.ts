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

/** A Shot-sheet row: lie + club picked on the phone at `tSec` (phone clock), standing at `point`
 * (the phone's fix — typically a walk on from where the ball actually was). */
function handEntered(
  roundHoleId: string,
  tSec: number,
  clubId: string | null,
  lie: Shot["lieStart"],
  point: LatLng,
  extra: Partial<Shot> = {}
): Shot {
  return {
    id: nid(),
    roundHoleId,
    shotNumber: 0,
    clubId,
    startPoint: point,
    endPoint: null,
    positionSource: "gps",
    accuracyM: 6,
    lieStart: lie,
    lieEnd: null,
    watchLapId: null,
    clubTapId: null,
    reconciliation: "manual",
    elevationM: null,
    targetPoint: null,
    targetSource: "default_green",
    swingType: lie === "green" ? "putt" : "full",
    intendedYards: null,
    penaltyType: null,
    excluded: null,
    exclusionNote: null,
    recordedAt: new Date(T0 + tSec * 1000).toISOString(),
    updatedAt: "",
    ...extra
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
    // Driver and 5i are full swings; the 56° is inside its 80-yard partial threshold; the putter
    // tag on the green is a putt rather than a full swing with the putter.
    expect(r.shots.map((s) => s.swingType)).toEqual(["full", "full", "partial", "putt"]);
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

    // Four strokes captured. The last is a putter tag with its lap press inside the green, so it
    // classifies as a putt rather than a full swing with the putter — three swings + one putt.
    expect(r.shots).toHaveLength(4);
    expect(swings(r)).toHaveLength(3);
    expect(r.shots.filter((s) => s.swingType === "putt")).toHaveLength(1);
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

  describe("clock calibration", () => {
    it("consumes the calibration lap, not a real shot", () => {
      // Calibration pressed 90s before the tee shot, and the watch DID record it.
      const calibrationAt = new Date(T0 - 90_000).toISOString();
      const laps = [lap(-90, pt(0, 0), 0), lap(0, pt(0, 0), 1), lap(300, pt(0, 240), 2)];
      const taps = [tap(-5, "driver"), tap(295, "5i")];
      const r = run({ laps, taps, calibrationPhoneTime: calibrationAt });

      expect(r.clockOffsetMethod).toBe("calibrated");
      expect(r.clockOffsetMs).toBe(0);
      // Three laps, one of which was the calibration press → two strokes.
      expect(swings(r)).toHaveLength(2);
      expect(r.shots.map((s) => s.clubId)).toEqual(["driver", "5i"]);
    });

    it("does NOT eat a stroke when the watch never recorded the calibration press", () => {
      // The player calibrated but the watch missed it, so every lap is a genuine shot. The old
      // guard compared a lap against an offset derived from that same lap — always zero, so it
      // always passed and always deleted the nearest lap, silently losing a stroke.
      const calibrationAt = new Date(T0 - 600_000).toISOString(); // ten minutes before play
      const laps = [lap(0, pt(0, 0), 0), lap(300, pt(0, 240), 1), lap(600, pt(0, 330), 2)];
      const taps = [tap(-5, "driver"), tap(295, "5i"), tap(595, "56")];
      const r = run({ laps, taps, calibrationPhoneTime: calibrationAt });

      expect(swings(r)).toHaveLength(3);
      expect(r.shots.map((s) => s.clubId)).toEqual(["driver", "5i", "56"]);
      // No lap sat at the calibration moment, so the offset falls back to estimation.
      expect(r.clockOffsetMethod).toBe("estimated");
    });
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

  // Case 10 — the headline behaviour: an approach shot's distance is measured from where it was
  // struck to where the FIRST putt started, not to the pin and not to the next hole's tee. Nothing
  // is scanned between the approach and the next tee, so the whole chain rests on frozenPutts[0].
  it("approach closes onto the first putt, not the pin", () => {
    const laps = [lap(0, pt(0, 0), 0), lap(300, pt(0, 240), 1)];
    const taps = [tap(-5, "driver"), tap(295, "56")];
    const firstPutt = greenPutt("rh1", pt(0, 330), pt(0, 352), 3);
    const secondPutt = greenPutt("rh1", pt(0, 352), pt(0, 355), 4);
    const r = run({ laps, taps, holes: [{ ...HOLE1, score: 4 }], existingShots: [firstPutt, secondPutt] });

    const approach = r.shots.find((s) => s.shotNumber === 2);
    expect(approach?.endPoint).toEqual(firstPutt.startPoint);
    // ...and specifically NOT the pin, which sits a full putt beyond it.
    expect(approach?.endPoint).not.toEqual(HOLE1.pin);
  });

  // Case 11 — saveGreenMarks writes a hole's putts in one tight loop, so they share a millisecond
  // and `recordedAt` ties; Dexie then returns them in UUID order, which is arbitrary. Feeding them
  // in reverse models the losing half of that coin flip. Ordering must come from shotNumber, which
  // the writer assigns explicitly — otherwise the approach chains to the SECOND putt and its
  // recorded distance is inflated by the length of the first.
  it("approach still closes onto the first putt when the putt rows arrive out of order", () => {
    const laps = [lap(0, pt(0, 0), 0), lap(300, pt(0, 240), 1)];
    const taps = [tap(-5, "driver"), tap(295, "56")];
    const firstPutt = greenPutt("rh1", pt(0, 330), pt(0, 352), 3);
    const secondPutt = greenPutt("rh1", pt(0, 352), pt(0, 355), 4);
    const r = run({ laps, taps, holes: [{ ...HOLE1, score: 4 }], existingShots: [secondPutt, firstPutt] });

    const approach = r.shots.find((s) => s.shotNumber === 2);
    expect(approach?.endPoint).toEqual(firstPutt.startPoint);
    // The putts must also keep their own order in the persisted output — the tap-in should never
    // be renumbered ahead of the long first putt.
    const putts = r.shots.filter((s) => s.swingType === "putt");
    expect(putts.map((s) => s.startPoint)).toEqual([firstPutt.startPoint, secondPutt.startPoint]);
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

  describe("hand-entered rows adopt the lap they duplicate (STEP 2b)", () => {
    // The phone flow: press the watch at the ball, walk on 25 m, pick lie + club in the app.
    const lapPoints = [pt(0, 0), pt(0, 240), pt(0, 330)];
    const phonePoints = [pt(0, 25), pt(0, 265), pt(0, 345)];
    const threeLaps = () => lapPoints.map((p, i) => lap(i * 300, p, i));
    const threeRows = () => [
      handEntered("rh1", 40, "driver", "tee", phonePoints[0]),
      handEntered("rh1", 340, "5i", "fairway", phonePoints[1]),
      handEntered("rh1", 640, "56", "rough", phonePoints[2])
    ];

    it("one stroke, two records: the row keeps club + lie, takes the lap's position and time", () => {
      const putt = greenPutt("rh1", pt(0, 350), pt(0, 355), 4);
      const r = run({ laps: threeLaps(), holes: [{ ...HOLE1, score: 4 }], existingShots: [...threeRows(), putt] });

      // Three swings + the marked putt — NOT six swings.
      expect(swings(r)).toHaveLength(3);
      expect(r.shots).toHaveLength(4);
      expect(r.handEnteredMerges).toBe(3);
      expect(r.flags.filter((f) => f.type === "missing_club" || f.type === "score_mismatch")).toHaveLength(0);

      const merged = swings(r);
      expect(merged.map((s) => s.clubId)).toEqual(["driver", "5i", "56"]);
      expect(merged.map((s) => s.lieStart)).toEqual(["tee", "fairway", "rough"]);
      merged.forEach((s, i) => {
        expect(s.reconciliation).toBe("manual");
        expect(s.startPoint).toEqual(lapPoints[i]);
        expect(s.positionSource).toBe("watch_lap");
        expect(s.accuracyM).toBeNull();
        expect(s.watchLapId).not.toBeNull();
        // The strike moment, not the moment the sheet was filled in.
        expect(Date.parse(s.recordedAt)).toBe(T0 + i * 300 * 1000);
      });
      // Chain runs through the lap positions.
      expect(merged[0].endPoint).toEqual(lapPoints[1]);
      expect(merged[2].endPoint).toEqual(putt.startPoint);
      // The laps report the rows they were folded into.
      const lapIds = new Set(merged.map((s) => s.watchLapId));
      expect(r.lapMatches.filter((m) => lapIds.has(m.lapId)).map((m) => m.shotId).sort()).toEqual(
        merged.map((s) => s.id).sort()
      );
    });

    it("a forgotten lap leaves the row where the phone was; a forgotten log leaves a lap_only shot", () => {
      const laps = threeLaps().filter((l) => l.lapIndex !== 1); // no press on the second shot
      const rows = threeRows().slice(0, 2); // third shot never logged
      const r = run({ laps, existingShots: rows });

      expect(swings(r)).toHaveLength(3);
      const [first, second, third] = swings(r);
      expect(first.watchLapId).not.toBeNull();
      expect(first.startPoint).toEqual(lapPoints[0]);
      // Second: hand-entered, no lap to adopt — the phone's own fix stands, honestly labelled.
      expect(second.clubId).toBe("5i");
      expect(second.watchLapId).toBeNull();
      expect(second.startPoint).toEqual(phonePoints[1]);
      expect(second.positionSource).toBe("gps");
      // Third: lap with no log — a shot of its own, asking for the club.
      expect(third.reconciliation).toBe("lap_only");
      expect(third.startPoint).toEqual(lapPoints[2]);
      expect(r.flags.filter((f) => f.type === "missing_club" && f.shotId === third.id)).toHaveLength(1);
      expect(r.handEnteredMerges).toBe(1);
    });

    it("the window is asymmetric: a log four minutes AFTER the lap merges, four minutes BEFORE does not", () => {
      // Tee shot: hit, waited for the group, walked on, logged 4 minutes later.
      const late = run({ laps: [lap(0, pt(0, 0), 0)], existingShots: [handEntered("rh1", 240, "driver", "tee", pt(0, 25))] });
      expect(swings(late)).toHaveLength(1);
      expect(swings(late)[0].watchLapId).not.toBeNull();
      // Nobody picks a club four minutes before hitting: two different strokes.
      const early = run({ laps: [lap(240, pt(0, 240), 0)], existingShots: [handEntered("rh1", 0, "driver", "tee", pt(0, 25))] });
      expect(swings(early)).toHaveLength(2);
      expect(early.handEnteredMerges).toBe(0);
    });

    it("each lap takes the nearest log in time, closest pairs first", () => {
      // Two laps 200s apart; the first was logged promptly, the second late — each still finds
      // its own row rather than the second row grabbing whichever lap it happens to be nearer.
      const laps = [lap(0, pt(0, 0), 0), lap(200, pt(0, 240), 1)];
      const rows = [handEntered("rh1", 30, "driver", "tee", pt(0, 25)), handEntered("rh1", 330, "5i", "fairway", pt(0, 265))];
      const r = run({ laps, existingShots: rows });

      expect(swings(r)).toHaveLength(2);
      expect(swings(r)[0].clubId).toBe("driver");
      expect(swings(r)[0].startPoint).toEqual(pt(0, 0));
      expect(swings(r)[1].clubId).toBe("5i");
      expect(swings(r)[1].startPoint).toEqual(pt(0, 240));
    });

    it("re-running is a no-op, and a previously double-counted round heals on re-run", () => {
      const laps = threeLaps();
      const first = run({ laps, existingShots: threeRows() });
      const second = run({ laps, existingShots: first.shots });
      expect(second.shots).toEqual(first.shots);
      expect(second.deleteShotIds).toHaveLength(0);
      expect(second.handEnteredMerges).toBe(0);

      // A round ingested under the old engine: lap_only rows sitting next to the hand-entered
      // ones. Re-running folds each lap into its row and drops the duplicate.
      const legacyLapOnly = run({ laps }).shots; // 3 lap_only rows
      expect(legacyLapOnly.every((s) => s.reconciliation === "lap_only")).toBe(true);
      const healed = run({ laps, existingShots: [...threeRows(), ...legacyLapOnly] });
      expect(swings(healed)).toHaveLength(3);
      expect(healed.deleteShotIds.sort()).toEqual(legacyLapOnly.map((s) => s.id).sort());
      expect(healed.handEnteredMerges).toBe(3);
    });

    it("re-attaching the watch file (fresh lap ids) re-links rows instead of duplicating them", () => {
      const first = run({ laps: threeLaps(), existingShots: threeRows() });
      const freshLaps = threeLaps(); // same presses, new ids — what parseFit produces
      const r = run({ laps: freshLaps, existingShots: first.shots });
      expect(swings(r)).toHaveLength(3);
      const freshIds = new Set(freshLaps.map((l) => l.id));
      expect(swings(r).every((s) => s.watchLapId !== null && freshIds.has(s.watchLapId))).toBe(true);
    });

    it("a row the player positioned by hand keeps that position and only gains the link", () => {
      const placed = pt(3, 2); // dragged onto the middle of the tee in review
      const rows = [handEntered("rh1", 40, "driver", "tee", placed, { positionSource: "manual", accuracyM: null, userEdited: true })];
      const r = run({ laps: [lap(0, pt(0, 0), 0)], existingShots: rows });
      expect(swings(r)).toHaveLength(1);
      expect(swings(r)[0].startPoint).toEqual(placed);
      expect(swings(r)[0].positionSource).toBe("manual");
      expect(swings(r)[0].watchLapId).not.toBeNull();
    });

    it("a tap near a hand-entered row is the same stroke: no tap_only shot; the row's club stands", () => {
      const rows = [handEntered("rh1", 40, "driver", "tee", phonePoints[0]), handEntered("rh1", 340, null, "fairway", phonePoints[1])];
      const taps = [tap(-5, "5i"), tap(295, "7i")]; // first tap disagrees with the row; second fills a blank
      const r = run({ laps: threeLaps().slice(0, 2), taps, existingShots: rows });
      expect(swings(r)).toHaveLength(2);
      expect(r.flags.filter((f) => f.type === "unmatched_tap")).toHaveLength(0);
      expect(swings(r)[0].clubId).toBe("driver");
      expect(swings(r)[1].clubId).toBe("7i");
      expect(swings(r).every((s) => s.clubTapId !== null && s.watchLapId !== null)).toBe(true);
    });

    it("penalty strokes and green-marked putts never adopt a lap", () => {
      const penalty = handEntered("rh1", 10, null, null, pt(0, 200), { penaltyType: "penalty_red", userEdited: true });
      const putt = greenPutt("rh1", pt(0, 350), pt(0, 355), 2);
      const r = run({ laps: [lap(0, pt(0, 0), 0), lap(2000, pt(0, 350), 1)], existingShots: [penalty, putt] });
      expect(r.handEnteredMerges).toBe(0);
      expect(r.shots.filter((s) => s.penaltyType !== null)[0].watchLapId).toBeNull();
      expect(r.shots.filter((s) => s.reconciliation === "green_mark")[0].watchLapId).toBeNull();
      expect(r.shots.filter((s) => s.reconciliation === "lap_only")).toHaveLength(2);
    });
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
