import * as turf from "@turf/turf";
import { db } from "./db";
import { getFeaturesForHole, getHolesForVersion, getLatestCourseVersion, ensureDefaultClubs } from "./courseRepo";
import { bearingDegrees, distanceYards, fromDownrangeOffline } from "./geo";
import { detectLie } from "./lie";
import { demElevation } from "./elevation";
import type {
  Club,
  ClubTap,
  Hole,
  HoleFeature,
  LatLng,
  Lie,
  ReviewFlag,
  Round,
  RoundHole,
  Shot,
  WatchLap
} from "../types/domain";

/**
 * Generates a complete, self-consistent example round so the review and stats screens can be
 * explored before ever walking a course.
 *
 * "Self-consistent" is the point: it doesn't just fabricate Shot rows. It also writes the
 * WatchLap and ClubTap rows those shots would have been reconciled FROM, links them both ways,
 * and marks the round reconciled — so re-running reconciliation over it is very nearly a no-op,
 * exactly as a real ingested round behaves. Putts are real Shot rows placed on the green, one
 * hole carries a penalty stroke, and a couple of review flags are left open so the correction
 * UI has something to act on.
 *
 * Shots are laid out along each hole's REAL geometry (tee box → green), so lies come from actual
 * polygon hit-testing rather than being invented.
 */

const DEMO_COURSE_SLUG = "innerkip-highlands";
const SHOT_INTERVAL_MS = 105_000; // ~1m45 between strokes
const HOLE_GAP_MS = 260_000; // walking to the next tee

/** Deterministic PRNG (mulberry32) — the same demo round every time it's generated, so what the
 * user sees is reproducible and any bug found in it is reproducible too. */
function makeRandom(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const uuid = () => crypto.randomUUID();

/** Typical carry per club for the simulated player (a high-80s golfer). */
const CLUB_YARDS: Record<string, number> = {
  Driver: 232,
  "5 Wood": 205,
  "4 Iron": 190,
  "5 Iron": 178,
  "6 Iron": 167,
  "7 Iron": 156,
  "8 Iron": 144,
  "9 Iron": 132,
  "50°": 115,
  "56°": 92,
  "60°": 68
};

/**
 * Club selection. Driver is a TEE club only — letting the picker reach for it on a second shot
 * had the simulated player flushing driver off the deck to reach a 457-yard par 5 in two, which
 * produced a fake eagle.
 *
 * Inside wedge range the choice is a PARTIAL swing with a scoring club rather than a full swing
 * with the next one down: an 75-yard shot is a three-quarter 56°, not a flat-out 60°. That's how
 * the shot is actually played, and it's what puts data in the partial-wedge stats.
 */
function chooseClub(remainingYards: number, isTeeShot: boolean, par: number, clubs: Club[]): Club | null {
  const byName = (n: string) => clubs.find((c) => c.name === n) ?? null;
  if (isTeeShot && par >= 4) return byName("Driver") ?? clubs[0] ?? null;

  if (remainingYards < 85) return byName("56°") ?? byName("60°");
  if (remainingYards < 112) return byName("50°") ?? byName("56°");

  const ordered = Object.entries(CLUB_YARDS)
    .filter(([name]) => name !== "Driver")
    .sort((a, b) => b[1] - a[1]);
  // Aim to land just short rather than long — the miss pattern that actually happens.
  for (const [name, yards] of ordered) {
    if (yards <= remainingYards + 8) return byName(name);
  }
  return byName("60°");
}

function gaussian(rnd: () => number): number {
  // Box-Muller, clamped so a single tail sample can't throw a shot into the next county.
  const u = Math.max(rnd(), 1e-9);
  const v = rnd();
  const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(-2.4, Math.min(2.4, g));
}

interface PlannedSwing {
  start: LatLng;
  end: LatLng;
  club: Club;
  lie: Lie;
}

interface PlannedHole {
  hole: Hole;
  tee: LatLng;
  pin: LatLng;
  swings: PlannedSwing[];
  puttStarts: LatLng[];
  penalty: { point: LatLng } | null;
  score: number;
}

function greenPointFor(hole: Hole, features: HoleFeature[]): LatLng | null {
  if (hole.greenPoint) return hole.greenPoint;
  const green =
    features.find((f) => f.featureType === "green" && f.geometry.type === "Polygon") ??
    features.find((f) => f.featureType === "fairway" && f.geometry.type === "Polygon");
  if (!green) return null;
  const [lng, lat] = turf.centroid(turf.feature(green.geometry)).geometry.coordinates;
  return { lat, lng };
}

/** Plays one hole: full swings toward the green, a greenside shot if the approach missed, then
 * putts. Positions are real coordinates on the hole, so lie detection does the rest. */
function playHole(
  hole: Hole,
  tee: LatLng,
  green: LatLng,
  features: HoleFeature[],
  clubs: Club[],
  rnd: () => number,
  withPenalty: boolean
): PlannedHole {
  const swings: PlannedSwing[] = [];
  let pos = tee;
  let penalty: { point: LatLng } | null = null;

  // Pin sits a few yards off the green centre, as a real Sunday pin does.
  const pinBearing = rnd() * 360;
  const pin = fromDownrangeOffline(green, pinBearing, 4 + rnd() * 5, 0);

  // Shots are routed along the hole's real CENTERLINE, not the straight tee→pin line. On a
  // dogleg the straight line is far shorter than the hole actually plays, and aiming at the pin
  // from the tee let the simulated player cut corners no golfer could — which showed up as a
  // fake eagle on a 457-yard par 5. Long shots aim at the point on the centerline one carry
  // ahead; once inside 50 yards of the end, aim at the flag like a real player would.
  const centerlineFeature = features.find((f) => f.featureType === "centerline" && f.geometry.type === "LineString");
  const line = centerlineFeature ? turf.lineString((centerlineFeature.geometry as GeoJSON.LineString).coordinates) : null;
  const lineLengthYards = line ? turf.length(line, { units: "yards" }) : distanceYards(tee, pin);

  const progressAlong = (p: LatLng): number => {
    if (!line) return lineLengthYards - distanceYards(p, pin);
    const snapped = turf.nearestPointOnLine(line, turf.point([p.lng, p.lat]), { units: "yards" });
    return snapped.properties.location as number;
  };
  const pointAlong = (yards: number): LatLng => {
    if (!line) return pin;
    const clamped = Math.max(0, Math.min(yards, lineLengthYards));
    const [lng, lat] = turf.along(line, clamped, { units: "yards" }).geometry.coordinates;
    return { lat, lng };
  };

  // Full swings until the ball is on the green. Distance is NOT capped to "just short of the
  // pin" — a strike between 86% and 102% of the club's nominal carry is what actually happens,
  // and letting approaches finish short is what produces a realistic scatter of pars and bogeys
  // rather than 18 straight greens in regulation.
  const onGreen = (p: LatLng) => detectLie(p, features) === "green";

  for (let guard = 0; guard < 9; guard++) {
    if (onGreen(pos)) break;
    const straightToPin = distanceYards(pos, pin);
    const alongRemaining = Math.max(lineLengthYards - progressAlong(pos), straightToPin);
    // Aim down the hole while there's hole left; switch to the flag on the approach.
    const aimDownHole = alongRemaining > 50 && !!line;
    const remaining = aimDownHole ? alongRemaining : straightToPin;
    if (remaining <= 30) break; // greenside — handled below

    const isTee = swings.length === 0;
    const club = chooseClub(remaining, isTee, hole.par, clubs);
    if (!club) break;

    const nominal = CLUB_YARDS[club.name] ?? 150;
    // A partial swing is throttled to the distance required, so its error is proportional rather
    // than "full carry minus a mishit". A full swing varies around the club's own number.
    const isPartialSwing = club.fullSwingMinYards != null && remaining < club.fullSwingMinYards;
    let carry = isPartialSwing ? remaining * (0.84 + rnd() * 0.28) : nominal * (0.86 + rnd() * 0.16);
    // The only cap: never fly the green by an absurd margin (a real player would club down).
    if (carry > remaining + 25) carry = remaining + rnd() * 12;

    const aimPoint = aimDownHole ? pointAlong(progressAlong(pos) + carry) : pin;
    // Travel the straight-line distance to the aim point: on a curving hole the chord is shorter
    // than the carry, so the ball correctly advances less than the club's nominal number.
    const travel = Math.min(carry, distanceYards(pos, aimPoint));
    // Lateral miss scales with how far the ball is going — a fixed spread made 30-yard pitches
    // as wild as 200-yard approaches, which wrecked the partial-wedge proximity numbers. The
    // coefficient is tuned so the simulated player scores in the low 80s, i.e. a real
    // mid-handicapper rather than the scratch golfer a tighter number produced.
    const lateralSpread = isTee ? 21 : Math.min(nominal > 150 ? 16 : 11, Math.max(2.5, travel * 0.105));
    const lateral = gaussian(rnd) * lateralSpread;
    const end = fromDownrangeOffline(pos, bearingDegrees(pos, aimPoint), travel, lateral);

    swings.push({ start: pos, end, club, lie: detectLie(pos, features) });
    pos = end;

    // The scripted penalty: one tee shot finds trouble and is replayed from near where it
    // entered, which is what stroke-and-distance relief actually looks like on the card.
    if (withPenalty && swings.length === 1) {
      penalty = { point: end };
      pos = fromDownrangeOffline(pos, bearingDegrees(pos, pin), -12, 6);
    }
  }

  // Greenside shots: chip/pitch until the ball is actually on the green. Whether one is needed
  // is decided by the real green polygon, not a distance guess — so a hole whose approach found
  // the putting surface simply goes straight to putting.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (onGreen(pos)) break;
    const leave = distanceYards(pos, pin);
    const wedge = clubs.find((c) => c.name === (leave > 45 ? "56°" : "60°")) ?? clubs.find((c) => c.name === "56°");
    if (!wedge) break;
    // Proximity from a short-game distribution: usually inside 25 feet, occasionally poor.
    const proximityYards = 2 + Math.abs(gaussian(rnd)) * 5.5;
    const end = fromDownrangeOffline(pin, rnd() * 360, proximityYards, 0);
    swings.push({ start: pos, end, club: wedge, lie: detectLie(pos, features) });
    pos = end;
  }

  // Putts, from a make-probability curve that roughly matches an amateur: tap-ins go in, short
  // ones usually do, and long-range two-putting is the norm with the occasional three.
  const leaveFeet = distanceYards(pos, pin) * 3;
  let puttCount: number;
  if (leaveFeet < 3) puttCount = 1;
  else if (leaveFeet < 9) puttCount = rnd() < 0.6 ? 1 : 2;
  else if (leaveFeet < 25) puttCount = rnd() < 0.16 ? 1 : 2;
  else if (leaveFeet < 55) puttCount = rnd() < 0.14 ? 3 : 2;
  else puttCount = rnd() < 0.32 ? 3 : 2;

  const puttStarts: LatLng[] = [];
  let puttPos = pos;
  for (let i = 0; i < puttCount; i++) {
    puttStarts.push(puttPos);
    // Each putt leaves a shorter one, so the last is a tap-in.
    const remainingFeet = distanceYards(puttPos, pin) * 3;
    const nextFeet = i === puttCount - 1 ? 0 : Math.max(1.2, remainingFeet * (0.1 + rnd() * 0.15));
    puttPos = nextFeet === 0 ? pin : fromDownrangeOffline(pin, rnd() * 360, nextFeet / 3, 0);
  }

  const score = swings.length + puttCount + (penalty ? 1 : 0);
  return { hole, tee, pin, swings, puttStarts, penalty, score };
}

export interface DemoRoundResult {
  roundId: string;
  courseName: string;
  strokes: number;
  toPar: number;
  holes: number;
}

export interface DemoHistoryResult {
  courseName: string;
  rounds: DemoRoundResult[];
}

/** How many rounds the sample history contains. One round leaves every club on "collecting" in
 * the stats engine — a handful of rounds is what makes the confidence tiers mean anything. */
const DEMO_ROUND_COUNT = 4;

/** True when the generated sample round is currently in the database. */
export async function hasDemoRound(): Promise<boolean> {
  return (await db.rounds.toArray()).some((r) => r.isDemo);
}

/** Removes the sample round and everything hanging off it. Real rounds are untouched. */
export async function removeDemoRound(): Promise<void> {
  const demoRounds = (await db.rounds.toArray()).filter((r) => r.isDemo);
  for (const round of demoRounds) {
    const roundHoles = await db.roundHoles.where("roundId").equals(round.id).toArray();
    const roundHoleIds = roundHoles.map((rh) => rh.id);
    if (roundHoleIds.length) {
      await db.shots.where("roundHoleId").anyOf(roundHoleIds).delete();
      await db.roundHoles.where("id").anyOf(roundHoleIds).delete();
    }
    await db.watchLaps.where("roundId").equals(round.id).delete();
    await db.clubTaps.where("roundId").equals(round.id).delete();
    await db.reviewFlags.where("roundId").equals(round.id).delete();
    await db.roundTracks.delete(round.id);
    await db.rounds.delete(round.id);
  }
}

/**
 * Builds the sample history: several rounds at Innerkip, newest first. Replaces any previous
 * sample so it's safe to run repeatedly. Only the most recent round carries the review flags and
 * the penalty, so the correction UI has something to act on without every round looking broken.
 */
export async function generateDemoRound(): Promise<DemoHistoryResult> {
  await removeDemoRound();

  const course = await db.courses.where("slug").equals(DEMO_COURSE_SLUG).first();
  if (!course) throw new Error("Innerkip Highlands isn't loaded yet — open the app once so bundled courses seed, then retry.");

  const version = await getLatestCourseVersion(course.id);
  if (!version) throw new Error("Innerkip Highlands has no course version to play against.");

  const holes = (await getHolesForVersion(version.id)).sort((a, b) => a.number - b.number);
  if (!holes.length) throw new Error("Innerkip Highlands has no holes imported.");

  const clubs = await ensureDefaultClubs();

  const rounds: DemoRoundResult[] = [];
  for (let i = 0; i < DEMO_ROUND_COUNT; i++) {
    // Newest round 6 days back, then roughly fortnightly before that.
    const daysAgo = 6 + i * 13;
    rounds.push(await buildOneRound(course.name, version.id, holes, clubs, daysAgo, 20260725 + i * 7919, i === 0));
  }

  return { courseName: course.name, rounds };
}

async function buildOneRound(
  courseName: string,
  courseVersionId: string,
  holes: Hole[],
  clubs: Club[],
  daysAgo: number,
  seed: number,
  withExtras: boolean
): Promise<DemoRoundResult> {
  const rnd = makeRandom(seed);

  const playedDate = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  playedDate.setHours(9, 12, 0, 0);
  let clock = playedDate.getTime();

  // Plan every hole first so the score is known before anything is written.
  const planned: PlannedHole[] = [];
  const penaltyHoleNumber = withExtras ? 7 : -1;
  for (const hole of holes) {
    const features = await getFeaturesForHole(hole.id);
    const teeBoxes = await db.teeBoxes.where("holeId").equals(hole.id).toArray();
    const green = greenPointFor(hole, features);
    const tee = teeBoxes[0]?.location ?? null;
    // Holes the OSM import left without a tee or green can't be simulated — they're skipped
    // rather than faked, and simply won't appear in the round.
    if (!tee || !green) continue;
    planned.push(playHole(hole, tee, green, features, clubs, rnd, hole.number === penaltyHoleNumber));
  }
  if (!planned.length) throw new Error("No hole on this course has both a tee box and a green to play from.");

  const round: Round = {
    id: uuid(),
    courseVersionId,
    playedOn: playedDate.toISOString().slice(0, 10),
    status: "completed",
    fitActivityId: "demo-activity",
    fitIngestedAt: new Date(clock).toISOString(),
    clockOffsetMs: 0,
    watchCalibrationAt: new Date(clock - 60_000).toISOString(),
    reconciledAt: new Date(clock).toISOString(),
    isDemo: true,
    updatedAt: new Date().toISOString()
  };

  const roundHoles: RoundHole[] = [];
  const shots: Shot[] = [];
  const laps: WatchLap[] = [];
  const taps: ClubTap[] = [];
  const flags: ReviewFlag[] = [];
  let lapIndex = 0;
  let strokes = 0;
  let par = 0;

  // Elevation comes from the real DEM when the network (or cache) can supply it; null otherwise,
  // which the stats engine treats as "no elevation correction" rather than guessing.
  async function elevationOf(p: LatLng): Promise<number | null> {
    try {
      return await demElevation(p);
    } catch {
      return null;
    }
  }

  for (const plan of planned) {
    const features = await getFeaturesForHole(plan.hole.id);
    const roundHole: RoundHole = {
      id: uuid(),
      roundId: round.id,
      holeId: plan.hole.id,
      score: plan.score,
      putts: plan.puttStarts.length,
      puttDistancesFeet: null,
      pinLocation: plan.pin,
      fairwayResult: null,
      updatedAt: new Date().toISOString()
    };

    let shotNumber = 1;
    const putterId = clubs.find((c) => c.name === "Putter")?.id ?? null;

    // --- full swings, each paired with the watch lap + club tap it came from ---
    for (let i = 0; i < plan.swings.length; i++) {
      const swing = plan.swings[i];
      const at = new Date(clock);
      clock += SHOT_INTERVAL_MS;

      const shotId = uuid();
      const lap: WatchLap = {
        id: uuid(),
        roundId: round.id,
        lapIndex: lapIndex++,
        tWatch: at.toISOString(),
        point: swing.start,
        elevationM: null,
        matchedShotId: shotId
      };
      const tap: ClubTap = {
        id: uuid(),
        roundId: round.id,
        // Tapped a few seconds before the swing, as you would pulling the club.
        tPhone: new Date(at.getTime() - 9000).toISOString(),
        clubId: swing.club.id,
        serialNumber: `demo-${swing.club.name.replace(/\s+/g, "-").toLowerCase()}`,
        point: swing.start,
        accuracyM: 4 + rnd() * 3,
        matchedShotId: shotId
      };
      laps.push(lap);
      taps.push(tap);

      const distToPin = distanceYards(swing.start, plan.pin);
      const isPartial = swing.club.fullSwingMinYards != null && distToPin < swing.club.fullSwingMinYards;

      shots.push({
        id: shotId,
        roundHoleId: roundHole.id,
        shotNumber: shotNumber++,
        clubId: swing.club.id,
        startPoint: swing.start,
        endPoint: swing.end,
        positionSource: "watch_lap",
        accuracyM: null,
        lieStart: swing.lie,
        lieEnd: detectLie(swing.end, features),
        watchLapId: lap.id,
        clubTapId: tap.id,
        reconciliation: "matched",
        elevationM: await elevationOf(swing.start),
        targetPoint: plan.pin,
        targetSource: i === 0 && plan.hole.par >= 4 ? "default_fairway" : "default_pin",
        swingType: isPartial ? "partial" : "full",
        intendedYards: isPartial ? Math.round(distToPin) : null,
        penaltyType: null,
        excluded: null,
        exclusionNote: null,
        recordedAt: at.toISOString(),
        updatedAt: at.toISOString(),
        userEdited: false
      });
    }

    // --- the scripted penalty stroke ---
    if (plan.penalty) {
      const at = new Date(clock);
      clock += 40_000;
      shots.push({
        id: uuid(),
        roundHoleId: roundHole.id,
        shotNumber: shotNumber++,
        clubId: null,
        startPoint: plan.penalty.point,
        endPoint: plan.penalty.point,
        positionSource: "manual",
        accuracyM: null,
        lieStart: null,
        lieEnd: null,
        watchLapId: null,
        clubTapId: null,
        reconciliation: "manual",
        elevationM: null,
        targetPoint: null,
        targetSource: "default_green",
        swingType: "full",
        intendedYards: null,
        penaltyType: "penalty_red",
        excluded: null,
        exclusionNote: null,
        recordedAt: at.toISOString(),
        updatedAt: at.toISOString(),
        userEdited: true
      });
    }

    // --- putts, as real Shot rows from the green-marking screen ---
    for (let i = 0; i < plan.puttStarts.length; i++) {
      const at = new Date(clock);
      clock += 55_000;
      const start = plan.puttStarts[i];
      const end = plan.puttStarts[i + 1] ?? plan.pin;
      shots.push({
        id: uuid(),
        roundHoleId: roundHole.id,
        shotNumber: shotNumber++,
        clubId: putterId,
        startPoint: start,
        endPoint: end,
        positionSource: "manual",
        accuracyM: null,
        lieStart: detectLie(start, features),
        lieEnd: "green",
        watchLapId: null,
        clubTapId: null,
        reconciliation: "green_mark",
        elevationM: null,
        targetPoint: plan.pin,
        targetSource: "default_pin",
        swingType: "putt",
        intendedYards: null,
        penaltyType: null,
        excluded: null,
        exclusionNote: null,
        recordedAt: at.toISOString(),
        updatedAt: at.toISOString(),
        userEdited: false
      });
    }

    roundHoles.push(roundHole);
    strokes += plan.score;
    par += plan.hole.par;
    clock += HOLE_GAP_MS;
  }

  // --- a couple of open flags so the review queue has real work in it (newest round only) ---
  const flagHole = withExtras ? roundHoles[2] : undefined;
  if (flagHole) {
    const holeShots = shots.filter((s) => s.roundHoleId === flagHole.id && s.swingType !== "putt");
    const second = holeShots[1];
    if (second) {
      flags.push({
        id: uuid(),
        roundId: round.id,
        roundHoleId: flagHole.id,
        shotId: second.id,
        type: "ambiguous_lie",
        detail: `Position is within 2m of a surface boundary — best guess "${second.lieStart ?? "rough"}".`,
        status: "open",
        createdAt: new Date(clock).toISOString(),
        resolvedAt: null
      });
    }
  }
  const missingClubHole = withExtras ? roundHoles[9] : undefined;
  if (missingClubHole) {
    const target = shots.find((s) => s.roundHoleId === missingClubHole.id && s.swingType !== "putt" && s.penaltyType === null);
    if (target) {
      // Genuinely strip the club so the flag describes a real gap in the data, not a fiction.
      target.clubId = null;
      target.reconciliation = "lap_only";
      target.clubTapId = null;
      const orphanTap = taps.findIndex((t) => t.matchedShotId === target.id);
      if (orphanTap >= 0) taps.splice(orphanTap, 1);
      flags.push({
        id: uuid(),
        roundId: round.id,
        roundHoleId: missingClubHole.id,
        shotId: target.id,
        type: "missing_club",
        detail: "Lap press with no club tap within 90s — which club was this?",
        status: "open",
        createdAt: new Date(clock).toISOString(),
        resolvedAt: null
      });
    }
  }

  await db.transaction(
    "rw",
    [db.rounds, db.roundHoles, db.shots, db.watchLaps, db.clubTaps, db.reviewFlags],
    async () => {
      await db.rounds.put(round);
      await db.roundHoles.bulkPut(roundHoles);
      await db.shots.bulkPut(shots);
      await db.watchLaps.bulkPut(laps);
      await db.clubTaps.bulkPut(taps);
      if (flags.length) await db.reviewFlags.bulkPut(flags);
    }
  );

  return {
    roundId: round.id,
    courseName,
    strokes,
    toPar: strokes - par,
    holes: roundHoles.length
  };
}
