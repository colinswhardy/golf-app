import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import * as turf from "@turf/turf";
import { db } from "../lib/db";
import { ensureDefaultClubs, getFeaturesForHole, getHolesForVersion, getLatestCourseVersion, updateHoleNotes } from "../lib/courseRepo";
import {
  completeRound,
  getActiveRoundForCourse,
  getOrCreateRoundHole,
  recordShot,
  saveHoleResult,
  setRoundHoleFairwayResult,
  setRoundHolePinLocation,
  startRound
} from "../lib/roundRepo";
import { ALL_LIES, LIE_LABELS, detectLie } from "../lib/lie";
import { classifyFairwayResult } from "../lib/fairway";
import { correctShot, saveGreenMarks } from "../lib/roundRepo";
import { addReviewFlag, clubIdForSerial, recordClubTap, recordWatchCalibration, setReviewFlagStatus } from "../lib/captureRepo";
import { armScanning, isNfcSupported } from "../lib/nfc";
import { CourseMap, OUTDOORS_STYLE, SATELLITE_STYLE, type DispersionEllipseSpec } from "../components/CourseMap";
import { GreenMap } from "../components/GreenMap";
import { HoleScoreSheet, ScorecardSheet, ShotSheet, relativeToParLabel } from "../components/RoundSheets";
import { bearingDegrees, distanceMeters, distanceYards, fromDownrangeOffline } from "../lib/geo";
import { getClubDispersion } from "../lib/dispersion";
import { isGpsEnabled } from "../lib/settings";
import type { Club, FairwayResult, LatLng, Lie, Round, RoundHole } from "../types/domain";

const GREENSIDE_BUNKER_MAX_YARDS = 40;
const FAR_FROM_HOLE_METERS = 300;
const GREEN_HALF_DEPTH_YARDS = 15;
const TEE_PREFERENCE_KEY = "caddyshot_tee_preference";
const AUTO_LAYUP_MIN_HOLE_YARDS = 300;
const AUTO_LAYUP_DOWNRANGE_YARDS = 275;
const TAP_MOVE_TOLERANCE_PX = 10;

// Personal, single-user app — no auth/profile system exists (or is needed) to derive this from.
const PLAYER_NAME = "Colin";
const PLAYER_INITIALS = "CH";

function centroidLatLng(geom: GeoJSON.Polygon): LatLng {
  const [lng, lat] = turf.centroid(turf.feature(geom)).geometry.coordinates;
  return { lat, lng };
}

// Finds where the tee->green line crosses the fairway polygon boundary and returns the midpoint
// of the "inside the fairway" segment between two crossings — used as the automatic layup dot's
// fallback when the fixed AUTO_LAYUP_DOWNRANGE_YARDS point itself misses the fairway (e.g. a
// dogleg). A straight line can cross a polygon boundary more than twice for oddly-shaped
// fairways, so this checks every consecutive pair of crossings (sorted by distance from the tee)
// and picks the one whose own midpoint actually falls inside the polygon, preferring the widest
// such segment if more than one qualifies.
function fairwayCenterlineSegmentMidpoint(tee: LatLng, green: LatLng, fairwayPolygon: GeoJSON.Feature<GeoJSON.Polygon>): LatLng | null {
  const line = turf.lineString([
    [tee.lng, tee.lat],
    [green.lng, green.lat]
  ]);
  const boundary = turf.polygonToLine(fairwayPolygon) as GeoJSON.Feature<GeoJSON.LineString | GeoJSON.MultiLineString>;
  const hits = turf.lineIntersect(line, boundary);
  if (hits.features.length < 2) return null;

  const sorted = hits.features
    .map((f) => {
      const [lng, lat] = f.geometry.coordinates;
      return { lat, lng, d: distanceYards(tee, { lat, lng }) };
    })
    .sort((a, b) => a.d - b.d);

  let best: { mid: LatLng; span: number } | null = null;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const mid: LatLng = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
    if (!turf.booleanPointInPolygon(turf.point([mid.lng, mid.lat]), fairwayPolygon)) continue;
    const span = b.d - a.d;
    if (!best || span > best.span) best = { mid, span };
  }
  return best?.mid ?? null;
}

function getHoleOrdinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export function RoundMapPage() {
  const { courseId } = useParams();
  const isDemo = courseId === "demo" || !courseId;

  const courseVersion = useLiveQuery(() => (isDemo ? undefined : getLatestCourseVersion(courseId!)), [courseId]);
  const holes = useLiveQuery(() => (courseVersion ? getHolesForVersion(courseVersion.id) : []), [courseVersion?.id]);

  const [holeNumber, setHoleNumber] = useState(1);
  const currentHole = useMemo(() => holes?.find((h) => h.number === holeNumber), [holes, holeNumber]);

  const holeFeatures = useLiveQuery(() => (currentHole ? getFeaturesForHole(currentHole.id) : []), [currentHole?.id]);
  const teeBoxes = useLiveQuery(
    () => (currentHole ? db.teeBoxes.where("holeId").equals(currentHole.id).toArray() : []),
    [currentHole?.id]
  );

  // --- Round state ---
  const [round, setRound] = useState<Round | null>(null);
  const [clubs, setClubs] = useState<Club[]>([]);
  const [roundHoleId, setRoundHoleId] = useState<string | null>(null);
  const [openSheet, setOpenSheet] = useState<"shot" | "score" | "scorecard" | null>(null);
  // Latest GPS fix + its reported accuracy. Kept together so a recorded shot can carry honest
  // provenance (positionSource/accuracyM) instead of a bare coordinate of unknown quality.
  const lastPositionRef = useRef<{ point: LatLng; accuracyM: number | null } | null>(null);
  // Tracks pointerdown position on the map wrapper to distinguish a tap (dismisses the notes
  // popover) from a drag/pan (which also ends in a native click but shouldn't dismiss anything).
  const mapPointerDownRef = useRef<{ x: number; y: number } | null>(null);

  // --- Grint-style map controls, lifted so the right-side pill can drive CourseMap externally ---
  const [settingTarget, setSettingTarget] = useState(false);
  const [mapStyle, setMapStyle] = useState(SATELLITE_STYLE);
  const [centerDistance, setCenterDistance] = useState<number | null>(null);
  const [waterWarningYards, setWaterWarningYards] = useState<number | null>(null);

  // --- Dispersion overlay: pick a club, show its (manual or actual, per the club's own flag)
  // shot ellipse. CourseMap centers it on the dot in play for the current shot (nearest layup dot
  // for shot 1, second for shot 2, the green/pin for shot 3+ — see getDispersionCenter there). ---
  const [dispersionPickerOpen, setDispersionPickerOpen] = useState(false);
  const [activeClubId, setActiveClubId] = useState<string | null>(null);
  const [dispersionEllipse, setDispersionEllipse] = useState<DispersionEllipseSpec | null>(null);
  useEffect(() => {
    const club = clubs.find((c) => c.id === activeClubId);
    if (!club) {
      setDispersionEllipse(null);
      return;
    }
    let cancelled = false;
    getClubDispersion(club).then((spec) => {
      if (!cancelled) setDispersionEllipse(spec);
    });
    return () => {
      cancelled = true;
    };
  }, [activeClubId, clubs]);

  // Live GPS on/off (Settings toggle). Read once on mount — flipping it takes effect next time the
  // round map is opened, which is fine for a rarely-touched preference.
  const [gpsEnabled] = useState(isGpsEnabled);

  // --- Capture streams (REVISION-SPEC Phase 2): NFC club taps + screen wake lock + green marking ---
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showToast(msg: string) {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => setToast(null), 2500);
  }

  const [nfcActive, setNfcActive] = useState(false);
  const nfcStopRef = useRef<(() => void) | null>(null);
  // Arms continuous tag scanning for the round. Must be called from a user gesture (Start round,
  // or the 🏷️ indicator after a mid-round reload). Every read = one ClubTap row + a toast —
  // deliberately NO sheet, NO confirmation (spec 2.1): tap the bag, keep walking.
  async function armNfc(roundId: string) {
    if (!isNfcSupported() || nfcStopRef.current) return;
    try {
      nfcStopRef.current = await armScanning(
        async (serial, at) => {
          const clubId = await clubIdForSerial(serial);
          if (!clubId) {
            showToast("Unpaired tag");
            return;
          }
          const fix = lastPositionRef.current;
          await recordClubTap({
            roundId,
            clubId,
            serialNumber: serial,
            at,
            point: fix?.point ?? null,
            accuracyM: fix?.accuracyM ?? null
          });
          const club = (await ensureDefaultClubs()).find((c) => c.id === clubId);
          showToast(`🏷️ ${club?.name ?? "Club"}`);
        },
        (msg) => showToast(`NFC: ${msg}`)
      );
      setNfcActive(true);
    } catch {
      showToast("NFC unavailable on this device");
    }
  }
  function stopNfc() {
    nfcStopRef.current?.();
    nfcStopRef.current = null;
    setNfcActive(false);
  }
  useEffect(() => stopNfc, []); // page unmount

  // Screen wake lock while a round is active (spec 2.2): NFC only delivers while the page is
  // visible, so the screen staying on IS the capture reliability story. Re-acquired on
  // visibilitychange because the OS silently releases it whenever the page is hidden.
  const [wakeLockHeld, setWakeLockHeld] = useState(false);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  useEffect(() => {
    if (!round) return;
    let cancelled = false;
    async function acquire() {
      if (cancelled || !("wakeLock" in navigator)) return;
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (cancelled) {
          lock.release().catch(() => {});
          return;
        }
        wakeLockRef.current = lock;
        setWakeLockHeld(true);
        lock.addEventListener("release", () => {
          if (!cancelled) setWakeLockHeld(false);
        });
      } catch {
        // Denied (battery saver etc.) — indicator simply stays off.
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") acquire();
    };
    document.addEventListener("visibilitychange", onVisibility);
    acquire();
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
      setWakeLockHeld(false);
    };
  }, [round?.id]);

  // Green-marking screen (spec 2.3): openable any time via the ⛳ pill, and force-shown at
  // hole-out when the hole has no marks yet (no pinLocation).
  const [greenMapOpen, setGreenMapOpen] = useState(false);
  const pendingHoleOutRef = useRef(false);
  async function handleGreenFinish(pin: LatLng, puttStarts: LatLng[]) {
    if (!roundHoleId) return;
    await saveGreenMarks({
      roundHoleId,
      pin,
      puttStarts,
      detectLieAt: (p) => detectLie(p, holeFeatures ?? [])
    });
    setGreenMapOpen(false);
    if (pendingHoleOutRef.current) {
      pendingHoleOutRef.current = false;
      setOpenSheet("score");
    }
  }

  async function handleCalibrateWatch() {
    if (!round) return;
    await recordWatchCalibration(round.id);
    setRound({ ...round, watchCalibrationAt: new Date().toISOString() });
    showToast("⌚ Now press the watch lap button!");
  }

  // --- Next-tee prompt (REVISION-SPEC 4.1): open flags on the just-completed hole surface as a
  // compact card. Never blocks play; "Later" defers to the end-of-round queue (dismissed ≠
  // resolved). Live flags come from the hole-out balance check below; post-ingest flags surface
  // in review instead. ---
  const [lastCompletedRoundHoleId, setLastCompletedRoundHoleId] = useState<string | null>(null);
  const nextTeeFlags = useLiveQuery(async () => {
    if (!round || !lastCompletedRoundHoleId) return [];
    const flags = await db.reviewFlags.where("roundId").equals(round.id).toArray();
    return flags.filter((f) => f.roundHoleId === lastCompletedRoundHoleId && f.status === "open");
  }, [round?.id, lastCompletedRoundHoleId]);
  const nextTeeFlag = nextTeeFlags?.[0] ?? null;
  const flaggedShot = useLiveQuery(
    () => (nextTeeFlag?.shotId ? db.shots.get(nextTeeFlag.shotId) : undefined),
    [nextTeeFlag?.shotId]
  );

  async function dismissNextTeeFlags() {
    for (const f of nextTeeFlags ?? []) await setReviewFlagStatus(f.id, "dismissed");
  }
  async function fixFlagNow() {
    if (!nextTeeFlag) return;
    if (nextTeeFlag.type === "score_mismatch") {
      // Jump back to the flagged hole and reopen the score sheet — saving a balancing score
      // resolves the flag in handleSaveHole.
      const rh = allRoundHoles?.find((r) => r.id === nextTeeFlag.roundHoleId);
      const hole = holes?.find((h) => h.id === rh?.holeId);
      if (hole) {
        setHoleNumber(hole.number);
        setOpenSheet("score");
      }
    }
  }
  async function fixFlagLie(lie: Lie) {
    if (!nextTeeFlag?.shotId) return;
    await correctShot(nextTeeFlag.shotId, { lieStart: lie });
    await setReviewFlagStatus(nextTeeFlag.id, "resolved");
  }

  // --- Per-hole notes: freeform text tied to the hole (not the round), auto-saved on a short
  // debounce so there's no explicit save action to remember to tap ---
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");
  useEffect(() => {
    setNotesDraft(currentHole?.notes ?? "");
  }, [currentHole?.id]);
  useEffect(() => {
    if (!currentHole || notesDraft === (currentHole.notes ?? "")) return;
    const timer = setTimeout(() => updateHoleNotes(currentHole.id, notesDraft || null), 600);
    return () => clearTimeout(timer);
  }, [notesDraft, currentHole]);

  // Preferred tee set (e.g. "Blue"), persisted across sessions. Empty string = no preference set
  // yet, meaning "use the backmost tee" (see fallbackOrigin below).
  const [selectedTeeName, setSelectedTeeName] = useState<string>(() =>
    typeof localStorage === "undefined" ? "" : (localStorage.getItem(TEE_PREFERENCE_KEY) ?? "")
  );
  // Hides the tee selector card immediately once a choice is made, rather than leaving it
  // sitting open for the rest of pre-round setup — the choice is already saved (localStorage),
  // so there's nothing left for the card to do. Resets on hole change so it's available again
  // if you want to reconsider on a later hole (still pre-round only, per the render gate below).
  const [teeSelectorClosed, setTeeSelectorClosed] = useState(false);
  useEffect(() => {
    setTeeSelectorClosed(false);
  }, [currentHole?.id]);
  function handleTeeChange(name: string) {
    setSelectedTeeName(name);
    setTeeSelectorClosed(true);
    if (typeof localStorage === "undefined") return;
    if (name) localStorage.setItem(TEE_PREFERENCE_KEY, name);
    else localStorage.removeItem(TEE_PREFERENCE_KEY);
  }

  useEffect(() => {
    if (isDemo || !courseId) return;
    getActiveRoundForCourse(courseId).then((r) => setRound(r ?? null));
    ensureDefaultClubs().then(setClubs);
  }, [isDemo, courseId]);

  // A RoundHole row is created lazily the first time you interact with a hole during a round.
  // resolvedRoundHole seeds pinDataReady/currentRoundHole (below) with the SAME row
  // getOrCreateRoundHole just resolved, so they don't have to wait for the separate live query to
  // independently catch up to a roundHoleId we already have the full row for. Without this,
  // starting a round (round null -> non-null, this effect re-firing) briefly flips pinDataReady
  // false for the render or two before the live query resolves, which unmounts CourseMap and
  // silently wipes any measure dots the player had already placed pre-round.
  const [resolvedRoundHole, setResolvedRoundHole] = useState<RoundHole | null>(null);
  useEffect(() => {
    setRoundHoleId(null);
    setResolvedRoundHole(null);
    if (!round || !currentHole) return;
    getOrCreateRoundHole(round.id, currentHole.id).then((rh) => {
      setResolvedRoundHole(rh);
      setRoundHoleId(rh.id);
    });
  }, [round, currentHole?.id]);

  // Live so a dragged/tapped pin (persisted via onTargetChange below) is picked back up
  // correctly if you navigate away from this hole and back. Falls back to resolvedRoundHole
  // (above) until this live query's own result for the current roundHoleId comes in.
  const currentRoundHoleLive = useLiveQuery(
    () => (roundHoleId ? db.roundHoles.get(roundHoleId) : undefined),
    [roundHoleId]
  );
  const currentRoundHole = currentRoundHoleLive ?? resolvedRoundHole ?? undefined;

  const shots = useLiveQuery(
    () => (roundHoleId ? db.shots.where("roundHoleId").equals(roundHoleId).toArray() : []),
    [roundHoleId]
  );
  // Putts are Shot rows now (reconciliation "green_mark") — swing numbering, the score sheet's
  // "recorded shots" and dispersion centering all count SWINGS only, or green marking would
  // double-count against the putts stepper.
  const shotCount = shots?.filter((s) => s.reconciliation !== "green_mark").length ?? 0;

  // All roundHoles played so far this round, for the bottom-bar relative score + scorecard sheet.
  const allRoundHoles = useLiveQuery(
    () => (round ? db.roundHoles.where("roundId").equals(round.id).toArray() : []),
    [round?.id]
  );
  const scorecardEntries = useMemo(() => {
    if (!holes) return [];
    return holes.map((h) => ({
      holeNumber: h.number,
      par: h.par,
      score: allRoundHoles?.find((rh) => rh.holeId === h.id)?.score ?? null
    }));
  }, [holes, allRoundHoles]);
  const relativeScore = useMemo(
    () => scorecardEntries.reduce((s, e) => (e.score !== null ? s + (e.score - e.par) : s), 0),
    [scorecardEntries]
  );

  // All tee boxes across the whole course, used once to auto-pick a starting hole from live GPS.
  const allTeeBoxes = useLiveQuery(async () => {
    if (!holes?.length) return [];
    const ids = holes.map((h) => h.id);
    return db.teeBoxes.where("holeId").anyOf(ids).toArray();
  }, [holes]);

  const didAutoSelect = useRef(false);
  useEffect(() => {
    if (isDemo || didAutoSelect.current || !allTeeBoxes?.length || !navigator.geolocation) return;
    didAutoSelect.current = true;
    navigator.geolocation.getCurrentPosition((pos) => {
      const me: LatLng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      let best: { holeId: string; dist: number } | null = null;
      for (const tb of allTeeBoxes) {
        const d = distanceMeters(me, tb.location);
        if (!best || d < best.dist) best = { holeId: tb.holeId, dist: d };
      }
      if (best && best.dist <= FAR_FROM_HOLE_METERS) {
        const hole = holes?.find((h) => h.id === best!.holeId);
        if (hole) setHoleNumber(hole.number);
      }
    });
  }, [isDemo, allTeeBoxes, holes]);

  const greenCentroid = useMemo(() => {
    if (!currentHole) return null;
    // A course-editor green override wins over the derived polygon centroid — and, crucially,
    // works even for holes the OSM import left with no green polygon at all (which otherwise
    // never resolve a target and stay stuck on "Loading course…").
    if (currentHole.greenPoint) return currentHole.greenPoint;
    if (!holeFeatures?.length) return null;
    // Dexie's live-query hook keeps returning the PREVIOUS hole's already-resolved rows for a
    // few renders after currentHole.id changes, before the new query catches up — a plain
    // truthy/non-empty check doesn't catch this since the stale data is real, just for the
    // wrong hole. CourseMap only reads its initialTarget prop once at mount, and remounts
    // immediately on hole change (key={currentHole.id}), so trusting mismatched data here would
    // permanently lock the new hole's camera onto the old hole's green.
    if (!holeFeatures.every((f) => f.holeId === currentHole.id)) return null;
    const green =
      holeFeatures.find((f) => f.featureType === "green" && f.geometry.type === "Polygon") ??
      holeFeatures.find((f) => f.featureType === "fairway" && f.geometry.type === "Polygon");
    return green ? centroidLatLng(green.geometry as GeoJSON.Polygon) : null;
  }, [holeFeatures, currentHole]);

  // A custom dragged/tapped pin overrides the green centroid default, once one's been set for
  // this hole this round.
  const activeTarget = currentRoundHole?.pinLocation ?? greenCentroid;
  // Whether pin data is safe to consider "resolved": if a round hole exists (roundHoleId set),
  // wait for its row to actually load before mounting CourseMap, so a pin saved earlier in this
  // round isn't missed — CourseMap only reads its initialTarget prop once, at mount, so mounting
  // before this resolves would permanently lock onto the green centroid instead. Not needed
  // pre-round (roundHoleId null), when there's no pin concept yet. In practice this almost never
  // blocks anymore now that currentRoundHole falls back to resolvedRoundHole above — only a
  // (still theoretically possible) gap between roundHoleId being set and either value existing.
  const pinDataReady = !roundHoleId || currentRoundHole !== undefined;

  // Excludes the generic "Tee" fallback name from the dropdown whenever real color sets (Blue,
  // White, Gold, ...) exist — no point offering a vague "Tee" option alongside specific ones.
  // Only falls back to including "Tee" when it's literally the only name available.
  const uniqueTeeNames = useMemo(() => {
    if (!allTeeBoxes?.length) return [];
    const names = [...new Set(allTeeBoxes.map((t) => t.name))].sort();
    const colorNames = names.filter((n) => n !== "Tee");
    return colorNames.length > 0 ? colorNames : names;
  }, [allTeeBoxes]);

  // Prefers the selected tee set for this hole; falls back to the backmost tee box (furthest
  // from the green) when no preference is set, or when this hole doesn't have a tee box under
  // that name (tee-set naming can be inconsistent hole-to-hole in the source OSM data).
  const fallbackOrigin = useMemo(() => {
    if (!teeBoxes?.length || !currentHole) return null;
    // Same stale-data guard as greenCentroid above — teeBoxes can briefly still hold the
    // previous hole's rows after currentHole.id has already changed.
    if (!teeBoxes.every((t) => t.holeId === currentHole.id)) return null;
    if (selectedTeeName) {
      const matched = teeBoxes.find((t) => t.name === selectedTeeName);
      if (matched) return matched.location;
    }
    if (!greenCentroid) return teeBoxes[0].location;
    const backmost = [...teeBoxes].sort(
      (a, b) => distanceYards(b.location, greenCentroid) - distanceYards(a.location, greenCentroid)
    )[0];
    return backmost.location;
  }, [teeBoxes, selectedTeeName, greenCentroid, currentHole]);

  // Suggested first layup dot: no dot on Par 3s or holes under 300y (nothing to lay up to);
  // otherwise prefers a point AUTO_LAYUP_DOWNRANGE_YARDS down the tee->green line (the closest
  // thing this app has to a real hole centerline at round-time — see DESIGN.md) if that lands
  // inside the fairway polygon. Otherwise falls back to the midpoint of the segment where the
  // tee->green line actually crosses the fairway polygon (e.g. a dogleg where 275y downrange
  // misses the short grass) — a better "aim here" suggestion than the fixed-distance point in
  // that case, and never too close to the tee the way "nearest fairway edge to the tee" could be.
  // Same stale-hole-data guard as greenCentroid/fallbackOrigin above, since CourseMap only acts on
  // this once per mount.
  const fairwayLayupPoint = useMemo(() => {
    if (!holeFeatures?.length || !currentHole || !fallbackOrigin || !greenCentroid) return null;
    if (!holeFeatures.every((f) => f.holeId === currentHole.id)) return null;
    if (currentHole.par === 3) return null;
    if (currentHole.defaultYardage !== null && currentHole.defaultYardage < AUTO_LAYUP_MIN_HOLE_YARDS) return null;
    const fairway = holeFeatures.find((f) => f.featureType === "fairway" && f.geometry.type === "Polygon");
    if (!fairway) return null;

    const bearing = bearingDegrees(fallbackOrigin, greenCentroid);
    const candidate = fromDownrangeOffline(fallbackOrigin, bearing, AUTO_LAYUP_DOWNRANGE_YARDS, 0);
    const fairwayPolygon = turf.polygon((fairway.geometry as GeoJSON.Polygon).coordinates);
    if (turf.booleanPointInPolygon(turf.point([candidate.lng, candidate.lat]), fairwayPolygon)) {
      return candidate;
    }

    const midpoint = fairwayCenterlineSegmentMidpoint(fallbackOrigin, greenCentroid, fairwayPolygon);
    if (midpoint) return midpoint;

    // Last resort, e.g. a sharp dogleg where the straight tee->green line never actually
    // crosses the fairway polygon at all: nearest point on the fairway boundary to the tee.
    const boundary = turf.polygonToLine(fairwayPolygon) as GeoJSON.Feature<GeoJSON.LineString | GeoJSON.MultiLineString>;
    const nearest = turf.nearestPointOnLine(boundary, turf.point([fallbackOrigin.lng, fallbackOrigin.lat]));
    const [lng, lat] = nearest.geometry.coordinates;
    return { lat, lng };
  }, [holeFeatures, currentHole, fallbackOrigin, greenCentroid]);

  const maxHoleNumber = holes?.length ? Math.max(...holes.map((h) => h.number)) : 18;

  async function handleStartRound() {
    if (!courseVersion) return;
    const r = await startRound(courseVersion.id);
    setRound(r);
    // This click IS the user gesture Web NFC's permission prompt needs — arm here, not in an
    // effect (spec 2.1).
    armNfc(r.id);
  }

  async function handleTargetChange(point: LatLng) {
    if (!roundHoleId) return;
    await setRoundHolePinLocation(roundHoleId, point);
  }

  async function handleSaveShot(clubId: string | null, lie: Lie) {
    if (!roundHoleId) return;
    // Fall back to the tee box when GPS hasn't locked yet (indoors, cold start) so the shot
    // still saves rather than blocking — but flagged as "tee_fallback" so distance statistics
    // can exclude it instead of treating a guessed coordinate as a real fix.
    const fix = lastPositionRef.current;
    const point = fix?.point ?? fallbackOrigin;
    if (!point) return;
    const resolvedLie: Lie =
      lie === "bunker_greenside" && greenCentroid && distanceYards(point, greenCentroid) > GREENSIDE_BUNKER_MAX_YARDS
        ? "bunker_fairway"
        : lie;
    await recordShot({
      roundHoleId,
      clubId,
      point,
      lie: resolvedLie,
      positionSource: fix ? "gps" : "tee_fallback",
      accuracyM: fix?.accuracyM ?? null
    });

    // Auto-detect the fairway result the instant Shot 2 lands (this point is both Shot 1's end
    // and Shot 2's start) — Par 4+ only, only when there's a mapped fairway to test against.
    // Still overridable later in the hole-out sheet (HoleScoreSheet pre-selects this value).
    if (shotCount === 1 && currentHole && currentHole.par >= 4 && fallbackOrigin && greenCentroid && holeFeatures) {
      const fairway = holeFeatures.find((f) => f.featureType === "fairway" && f.geometry.type === "Polygon");
      if (fairway) {
        const result = classifyFairwayResult(fairway.geometry as GeoJSON.Polygon, fallbackOrigin, greenCentroid, point);
        await setRoundHoleFairwayResult(roundHoleId, result);
      }
    }

    setOpenSheet(null);
  }

  async function handleSaveHole(score: number, putts: number, fairwayResult: FairwayResult | null) {
    if (!roundHoleId) return;
    await saveHoleResult({ roundHoleId, score, putts, fairwayResult, holeOutPoint: greenCentroid });

    // Live balance check (feeds the 4.1 next-tee card). Only when shots were actually being
    // recorded — a score-only hole shouldn't nag about "0 swings".
    if (round) {
      const openMismatch = (await db.reviewFlags.where("roundId").equals(round.id).toArray()).filter(
        (f) => f.roundHoleId === roundHoleId && f.type === "score_mismatch" && f.status !== "resolved"
      );
      if (shotCount > 0 && shotCount + putts !== score) {
        if (!openMismatch.length) {
          await addReviewFlag({
            roundId: round.id,
            roundHoleId,
            shotId: null,
            type: "score_mismatch",
            detail: `Hole ${currentHole?.number}: score ${score}, but ${shotCount} swing${shotCount === 1 ? "" : "s"} + ${putts} putt${putts === 1 ? "" : "s"} recorded.`
          });
        }
      } else {
        for (const f of openMismatch) await setReviewFlagStatus(f.id, "resolved");
      }
    }
    setLastCompletedRoundHoleId(roundHoleId);

    setOpenSheet(null);
    if (holeNumber < maxHoleNumber) {
      setHoleNumber(holeNumber + 1);
    } else if (round) {
      await completeRound(round.id);
      stopNfc();
      setRound(null);
    }
  }

  const detectedLie = useMemo(() => {
    if (!lastPositionRef.current || !holeFeatures?.length) return "rough" as const;
    return detectLie(lastPositionRef.current.point, holeFeatures);
  }, [openSheet, holeFeatures]); // recompute when the sheet opens, at the position you're standing

  const frontDistance = centerDistance !== null ? Math.max(0, centerDistance - GREEN_HALF_DEPTH_YARDS) : null;
  const backDistance = centerDistance !== null ? centerDistance + GREEN_HALF_DEPTH_YARDS : null;

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <Link to="/courses" style={backButtonStyle} aria-label="Back to courses">
        ←
      </Link>

      {!isDemo && currentHole && (
        <div style={holeHeaderStyle}>
          <button onClick={() => setHoleNumber((n) => Math.max(1, n - 1))} disabled={holeNumber <= 1} style={navButtonStyle}>
            ‹
          </button>
          <span>
            {getHoleOrdinal(currentHole.number)} - Par {currentHole.par}
            {currentHole.defaultYardage ? ` - ${currentHole.defaultYardage} Yards` : ""}
          </span>
          <button
            onClick={() => setHoleNumber((n) => Math.min(maxHoleNumber, n + 1))}
            disabled={holeNumber >= maxHoleNumber}
            style={navButtonStyle}
          >
            ›
          </button>
        </div>
      )}

      {!isDemo && currentHole && (
        <div style={bottomLeftHudStyle}>
          <div style={distanceRowStyle}>
            <span style={distanceLabelStyle}>BACK</span>
            <span>{backDistance ?? "—"}</span>
          </div>
          <div style={distanceRowStyle}>
            <span style={distanceLabelStyle}>CTR</span>
            <span style={{ fontSize: 34, fontWeight: 800 }}>{centerDistance ?? "—"}</span>
          </div>
          <div style={distanceRowStyle}>
            <span style={distanceLabelStyle}>FRONT</span>
            <span>{frontDistance ?? "—"}</span>
          </div>
          {waterWarningYards !== null && <div style={waterWarningRowStyle}>⚠️ Water: {waterWarningYards}y</div>}
        </div>
      )}

      {!isDemo && currentHole && (
        <div style={rightPillStyle}>
          <button
            onClick={() => setSettingTarget((s) => !s)}
            style={{ ...pillButtonStyle, ...(settingTarget ? pillButtonActiveStyle : {}) }}
            aria-label="Set target"
            title="Set Target"
          >
            🎯
          </button>
          <button
            onClick={() => setMapStyle((s) => (s === SATELLITE_STYLE ? OUTDOORS_STYLE : SATELLITE_STYLE))}
            style={pillButtonStyle}
            aria-label="Toggle map style"
            title="Toggle Map Type"
          >
            🗺️
          </button>
          <button
            onClick={() => setNotesOpen((v) => !v)}
            style={{ ...pillButtonStyle, ...(notesOpen ? pillButtonActiveStyle : {}) }}
            aria-label="Hole notes"
            title="Hole Notes"
          >
            📝
          </button>
          <button
            onClick={() => setDispersionPickerOpen((v) => !v)}
            style={{ ...pillButtonStyle, ...(dispersionEllipse ? pillButtonActiveStyle : {}) }}
            aria-label="Dispersion overlay"
            title="Shot Dispersion"
          >
            📐
          </button>
          {round && (
            <button
              onClick={() => setGreenMapOpen(true)}
              disabled={!roundHoleId}
              style={{ ...pillButtonStyle, ...(currentRoundHole?.pinLocation ? pillButtonActiveStyle : {}), opacity: roundHoleId ? 1 : 0.5 }}
              aria-label="Mark green"
              title="Mark Pin & Putts"
            >
              ⛳
            </button>
          )}
          {round && !round.watchCalibrationAt && (
            <button
              onClick={handleCalibrateWatch}
              style={pillButtonStyle}
              aria-label="Calibrate watch"
              title="Calibrate watch clock: tap this and press the watch lap button at the same moment"
            >
              ⌚
            </button>
          )}
          <button
            onClick={() => setOpenSheet("scorecard")}
            style={{ ...pillButtonStyle, fontSize: 16, fontWeight: 800 }}
            aria-label="Scorecard"
            title="Score Summary"
          >
            {round ? relativeToParLabel(relativeScore) : "–"}
          </button>
        </div>
      )}

      {!isDemo && toast && <div style={toastStyle}>{toast}</div>}

      {!isDemo && round && (
        <div style={captureIndicatorStyle}>
          <button
            onClick={() => (nfcActive ? stopNfc() : armNfc(round.id))}
            style={{ ...captureChipStyle, opacity: nfcActive ? 1 : 0.45 }}
            title={
              isNfcSupported()
                ? nfcActive
                  ? "NFC club tags: scanning (tap to stop)"
                  : "NFC club tags: off (tap to arm)"
                : "Web NFC not supported on this device"
            }
          >
            🏷️ {nfcActive ? "NFC" : "NFC off"}
          </button>
          {wakeLockHeld && (
            <span style={captureChipStyle} title="Screen staying awake so NFC taps register">
              ☀️ Awake
            </span>
          )}
        </div>
      )}

      {!isDemo && currentHole && notesOpen && (
        <div style={notesBoxStyle}>
          <textarea
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            placeholder="Notes for this hole (yardages, strategy, hazards)…"
            style={notesTextareaStyle}
            rows={3}
            autoFocus
          />
        </div>
      )}

      {!isDemo && currentHole && !notesOpen && currentHole.notes && (
        <button onClick={() => setNotesOpen(true)} style={notesPreviewStyle}>
          📝 Notes: {currentHole.notes}
        </button>
      )}

      {!isDemo && currentHole && dispersionPickerOpen && (
        <div style={clubPickerStyle}>
          <div style={clubPickerHeaderStyle}>
            <span>Dispersion</span>
            <button
              onClick={() => setDispersionPickerOpen(false)}
              style={clubPickerCloseStyle}
              aria-label="Close dispersion picker"
              title="Close"
            >
              ✕
            </button>
          </div>
          <button
            onClick={() => setActiveClubId(null)}
            style={{ ...clubChipStyle, ...(activeClubId === null ? clubChipActiveStyle : {}) }}
          >
            None
          </button>
          {clubs.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveClubId(c.id)}
              style={{ ...clubChipStyle, ...(activeClubId === c.id ? clubChipActiveStyle : {}) }}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      {/* Tap-away dismissal: a genuine TAP (minimal movement between pointerdown and pointerup)
          on the map itself (not the header/HUD/pill/sheets, all separate siblings stacked above
          via z-index) closes the notes popover. Tracked via pointer position rather than a plain
          onClick so panning/dragging the map — which still ends in a native click — doesn't also
          dismiss the popover. ShotSheet/HoleScoreSheet/ScorecardSheet already tap-away-dismiss
          via their own Sheet backdrop (RoundSheets.tsx), so this only needs to cover the notes
          popover, which has no backdrop of its own. */}
      <div
        onPointerDown={(e) => {
          mapPointerDownRef.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={(e) => {
          const start = mapPointerDownRef.current;
          mapPointerDownRef.current = null;
          if (!start || !notesOpen) return;
          const movedPx = Math.hypot(e.clientX - start.x, e.clientY - start.y);
          if (movedPx < TAP_MOVE_TOLERANCE_PX) setNotesOpen(false);
        }}
        style={{ position: "absolute", inset: 0 }}
      >
        {isDemo ? (
          <CourseMap />
        ) : currentHole && greenCentroid && fallbackOrigin && pinDataReady ? (
          // Gated on the derived greenCentroid/fallbackOrigin/pinDataReady themselves, not just on
          // the holeFeatures/teeBoxes queries having "resolved" — Dexie's live-query hook briefly
          // emits a genuinely-empty [] for each before converging on the real rows, so a
          // resolved-vs-undefined check opens one render too early. CourseMap's map-init effect
          // only runs once (on mount), so mounting before these are the real values would
          // permanently lock the camera onto the null/flat fallback instead of tee-facing-green —
          // and separately, would miss a pin saved earlier this round on this same hole.
          <CourseMap
            key={currentHole.id}
            initialTarget={activeTarget}
            fallbackOrigin={fallbackOrigin}
            holeFeatures={holeFeatures}
            onPositionChange={(p, accuracyM) => {
              lastPositionRef.current = { point: p, accuracyM };
            }}
            onDistanceUpdate={setCenterDistance}
            onWaterWarning={setWaterWarningYards}
            onTargetChange={handleTargetChange}
            settingTarget={settingTarget}
            onSettingTargetChange={setSettingTarget}
            mapStyle={mapStyle}
            hideInternalHud
            dispersionEllipse={dispersionEllipse}
            autoLayupPoint={fairwayLayupPoint}
            currentShotNumber={shotCount + 1}
            gpsEnabled={gpsEnabled}
            initialWaypoints={currentHole.waypoints}
          />
        ) : (
          <div style={{ padding: 24, color: "#eef2ef" }}>Loading course…</div>
        )}
      </div>

      {!isDemo && currentHole && !round && uniqueTeeNames.length > 0 && !teeSelectorClosed && (
        <div style={teeSelectorStyle}>
          <label htmlFor="tee-select" style={{ fontSize: 11, opacity: 0.75 }}>
            Tee
          </label>
          <select
            id="tee-select"
            value={selectedTeeName}
            onChange={(e) => handleTeeChange(e.target.value)}
            style={teeSelectStyle}
          >
            <option value="">Backmost (default)</option>
            {uniqueTeeNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      )}

      {!isDemo && round && nextTeeFlag && (
        <div style={nextTeeCardStyle}>
          <div style={{ fontSize: 13.5, marginBottom: 8 }}>⚠️ {nextTeeFlag.detail}</div>
          {nextTeeFlag.type === "ambiguous_lie" && flaggedShot ? (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
              {ALL_LIES.filter((l) => l !== "tee").map((l) => (
                <button
                  key={l}
                  onClick={() => fixFlagLie(l)}
                  style={{
                    ...nextTeeButtonStyle,
                    ...(flaggedShot.lieStart === l ? { background: "#f5d90a", color: "#111", border: "1px solid #f5d90a" } : {})
                  }}
                >
                  {LIE_LABELS[l]}
                </button>
              ))}
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            {nextTeeFlag.type === "score_mismatch" && (
              <button onClick={fixFlagNow} style={{ ...nextTeeButtonStyle, background: "#f5d90a", color: "#111", border: "1px solid #f5d90a" }}>
                Fix now
              </button>
            )}
            <button onClick={dismissNextTeeFlags} style={nextTeeButtonStyle}>
              Later
            </button>
          </div>
        </div>
      )}

      {!isDemo && currentHole && (
        <div style={bottomBarStyle}>
          <div style={profileRowStyle}>
            <div style={avatarStyle}>{PLAYER_INITIALS}</div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 600 }}>{PLAYER_NAME}</div>
              <div style={{ fontSize: 13, opacity: 0.7 }}>{round ? relativeToParLabel(relativeScore) : "Not started"}</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            {!round ? (
              <button onClick={handleStartRound} style={roundButtonStyle}>
                ⛳ Start round
              </button>
            ) : (
              <>
                <button
                  onClick={() => setOpenSheet("shot")}
                  disabled={!roundHoleId}
                  style={{ ...roundButtonStyle, opacity: roundHoleId ? 1 : 0.5 }}
                >
                  🏌️ Shot {shotCount + 1}
                </button>
                <button
                  onClick={() => {
                    // Force the green-marking screen at hole-out when the hole has no marks yet
                    // (spec 2.3) — the score sheet opens right after Finish.
                    if (!currentRoundHole?.pinLocation) {
                      pendingHoleOutRef.current = true;
                      setGreenMapOpen(true);
                    } else {
                      setOpenSheet("score");
                    }
                  }}
                  disabled={!roundHoleId}
                  style={roundButtonStyle}
                >
                  🏁 Hole Out
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {openSheet === "shot" && roundHoleId && (
        <ShotSheet
          shotNumber={shotCount + 1}
          clubs={clubs}
          detectedLie={detectedLie}
          onSave={handleSaveShot}
          onClose={() => setOpenSheet(null)}
        />
      )}
      {openSheet === "score" && roundHoleId && currentHole && (
        <HoleScoreSheet
          holeNumber={currentHole.number}
          par={currentHole.par}
          recordedShots={shotCount}
          markedPutts={currentRoundHole?.pinLocation ? currentRoundHole.putts : null}
          autoDetectedFairwayResult={currentRoundHole?.fairwayResult}
          onSave={handleSaveHole}
          onClose={() => setOpenSheet(null)}
        />
      )}
      {openSheet === "scorecard" && <ScorecardSheet entries={scorecardEntries} onClose={() => setOpenSheet(null)} />}

      {greenMapOpen && currentHole && greenCentroid && (
        <GreenMap
          greenPolygon={
            (holeFeatures?.find((f) => f.featureType === "green" && f.geometry.type === "Polygon")?.geometry as
              | GeoJSON.Polygon
              | undefined) ?? null
          }
          fallbackCenter={activeTarget ?? greenCentroid}
          initialPin={currentRoundHole?.pinLocation ?? null}
          holeNumber={currentHole.number}
          onFinish={handleGreenFinish}
          onClose={() => {
            pendingHoleOutRef.current = false;
            setGreenMapOpen(false);
          }}
        />
      )}
    </div>
  );
}

const backButtonStyle: React.CSSProperties = {
  position: "absolute",
  top: 16,
  left: 16,
  zIndex: 3,
  width: 40,
  height: 40,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "50%",
  background: "#ffffff",
  color: "#111",
  fontSize: 18,
  textDecoration: "none",
  boxShadow: "0 2px 6px rgba(0,0,0,.4)"
};

// Slim single-line "1st - Par 4 - 397 Yards" pill, no icons — pitch-black background with a thin
// emerald border for the sleeker high-contrast look, per the redesign.
const holeHeaderStyle: React.CSSProperties = {
  position: "absolute",
  top: 12,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 2,
  display: "flex",
  alignItems: "center",
  gap: 12,
  background: "#000000",
  border: "1px solid #16a34a",
  color: "#eef2ef",
  padding: "8px 18px",
  borderRadius: 999,
  fontSize: 18,
  fontWeight: 600,
  letterSpacing: 0.3,
  whiteSpace: "nowrap"
};

const navButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#eef2ef",
  fontSize: 28,
  padding: "0 8px",
  cursor: "pointer"
};

// Bottom-left column, stacked directly above the notes preview bar (bottom: 76, see
// notesPreviewStyle below) rather than beside it — bottomBarStyle (bottom: 0) -> notesPreviewStyle
// (bottom: 76) -> this (bottom: 122) forms one clean non-overlapping vertical stack on the left,
// leaving the right side (tee selector, utility pill) untouched. Stacks the green front/center/
// back distances and (when active) the water warning row in one translucent container.
const bottomLeftHudStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 122,
  left: 12,
  zIndex: 2,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 2,
  background: "rgba(15,46,26,0.85)",
  color: "#eef2ef",
  padding: "10px 14px",
  borderRadius: 16,
  minWidth: 64
};

const distanceRowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  lineHeight: 1.2,
  fontSize: 24,
  fontWeight: 600
};

const distanceLabelStyle: React.CSSProperties = {
  fontSize: 13,
  opacity: 0.7,
  letterSpacing: 0.5,
  fontWeight: 400
};

const rightPillStyle: React.CSSProperties = {
  position: "absolute",
  top: 76,
  right: 12,
  zIndex: 2,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  background: "rgba(11,15,12,0.75)",
  padding: 8,
  borderRadius: 999
};

const pillButtonStyle: React.CSSProperties = {
  width: 48,
  height: 48,
  borderRadius: "50%",
  background: "#1a3a24",
  border: "1px solid #2f5c3d",
  color: "#eef2ef",
  fontSize: 21,
  cursor: "pointer"
};

const pillButtonActiveStyle: React.CSSProperties = {
  background: "#f5d90a",
  // Full `border` shorthand, not just borderColor — mixing shorthand/non-shorthand for the
  // same property across re-renders (pillButtonStyle uses the `border` shorthand) throws a
  // React dev warning and can cause the un-set longhand pieces (width/style) to not reset.
  border: "1px solid #f5d90a"
};

const teeSelectorStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 76,
  right: 12,
  zIndex: 2,
  display: "flex",
  alignItems: "center",
  gap: 8,
  background: "rgba(11,15,12,0.85)",
  color: "#eef2ef",
  padding: "6px 12px",
  borderRadius: 999
};

const teeSelectStyle: React.CSSProperties = {
  background: "#1a3a24",
  color: "#eef2ef",
  border: "1px solid #2f5c3d",
  borderRadius: 999,
  padding: "6px 12px",
  fontSize: 16
};

const bottomBarStyle: React.CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 2,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  background: "rgba(11,15,12,0.92)",
  borderTop: "1px solid #2f5c3d",
  padding: "10px 16px",
  color: "#eef2ef"
};

const profileRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8
};

const avatarStyle: React.CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: "50%",
  background: "#2f5c3d",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 16,
  fontWeight: 700
};

const roundButtonStyle: React.CSSProperties = {
  padding: "12px 18px",
  background: "#1a3a24",
  color: "#eef2ef",
  border: "1px solid #2f5c3d",
  borderRadius: 999,
  fontSize: 18,
  cursor: "pointer"
};

// Adjacent to (just left of) the right-side utility pill, at the same top offset as its first
// button, rather than the header — opened via the pill's own 📝 button.
const notesBoxStyle: React.CSSProperties = {
  position: "absolute",
  top: 76,
  right: 64,
  zIndex: 2,
  width: "min(280px, 78vw)",
  background: "rgba(11,15,12,0.92)",
  border: "1px solid #2f5c3d",
  borderRadius: 12,
  padding: 8
};

// Left-aligned, directly above the bottom bar — a truncated one-line preview of the saved note;
// tapping it opens the same popover as the pill's 📝 button. Shares the left column with
// bottomLeftHudStyle (which stacks directly above this) rather than floating centered, so the
// two form one clean vertical stack instead of sitting side by side.
const notesPreviewStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 76,
  left: 12,
  zIndex: 2,
  maxWidth: "min(280px, 56vw)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  background: "#000000",
  border: "1px solid #16a34a",
  color: "#eef2ef",
  padding: "8px 16px",
  borderRadius: 999,
  fontSize: 15,
  cursor: "pointer"
};

const notesTextareaStyle: React.CSSProperties = {
  width: "100%",
  background: "#1a3a24",
  color: "#eef2ef",
  border: "1px solid #2f5c3d",
  borderRadius: 8,
  padding: 8,
  fontSize: 13,
  fontFamily: "inherit",
  resize: "vertical"
};

// 4.1 next-tee prompt: centered above the bottom bar, clear of the left HUD stack and the right
// pill — informative but never blocking (one-tap "Later" defers it to the review queue).
const nextTeeCardStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 76,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 3,
  width: "min(340px, 88vw)",
  background: "rgba(11,15,12,0.95)",
  border: "1px solid #d4a017",
  borderRadius: 12,
  padding: 12,
  color: "#eef2ef"
};

const nextTeeButtonStyle: React.CSSProperties = {
  padding: "8px 12px",
  background: "#1a3a24",
  color: "#eef2ef",
  border: "1px solid #2f5c3d",
  borderRadius: 999,
  fontSize: 13,
  cursor: "pointer"
};

const toastStyle: React.CSSProperties = {
  position: "absolute",
  top: 64,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 4,
  background: "rgba(0,0,0,0.88)",
  border: "1px solid #16a34a",
  color: "#eef2ef",
  padding: "10px 20px",
  borderRadius: 999,
  fontSize: 17,
  fontWeight: 700,
  whiteSpace: "nowrap",
  pointerEvents: "none"
};

// Small capture-status chips (NFC scanning, wake lock) bottom-right above the bottom bar —
// out of the way of the left HUD stack and the tee selector's pre-round slot.
const captureIndicatorStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 76,
  right: 12,
  zIndex: 2,
  display: "flex",
  gap: 6
};

const captureChipStyle: React.CSSProperties = {
  background: "rgba(11,15,12,0.85)",
  border: "1px solid #2f5c3d",
  color: "#eef2ef",
  padding: "6px 10px",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer"
};

const waterWarningRowStyle: React.CSSProperties = {
  marginTop: 6,
  paddingTop: 6,
  borderTop: "1px solid rgba(255,255,255,0.2)",
  fontSize: 15,
  fontWeight: 700,
  color: "#fca5a5",
  whiteSpace: "nowrap"
};

// Dispersion club picker — a vertical chip list under the right pill, with a header row carrying
// an explicit ✕ close button (the 📐 pill toggles it too, but a close control inside the panel is
// the obvious way to dismiss it once a club's been chosen).
const clubPickerStyle: React.CSSProperties = {
  position: "absolute",
  top: 130,
  right: 12,
  zIndex: 3,
  display: "flex",
  flexDirection: "column",
  gap: 6,
  maxHeight: "min(320px, 50vh)",
  overflowY: "auto",
  background: "rgba(11,15,12,0.94)",
  border: "1px solid #2f5c3d",
  borderRadius: 12,
  padding: 8
};

const clubPickerHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  color: "#eef2ef",
  fontSize: 13,
  fontWeight: 700,
  padding: "0 2px 4px",
  borderBottom: "1px solid #2f5c3d"
};

const clubPickerCloseStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#eef2ef",
  fontSize: 16,
  lineHeight: 1,
  cursor: "pointer",
  padding: "2px 4px"
};

const clubChipStyle: React.CSSProperties = {
  padding: "8px 14px",
  background: "#1a3a24",
  color: "#eef2ef",
  border: "1px solid #2f5c3d",
  borderRadius: 999,
  fontSize: 14,
  cursor: "pointer",
  whiteSpace: "nowrap"
};

const clubChipActiveStyle: React.CSSProperties = {
  background: "#f5d90a",
  color: "#111",
  border: "1px solid #f5d90a"
};

