import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import * as turf from "@turf/turf";
import { db } from "../lib/db";
import {
  ensureDefaultClubs,
  getFeaturesForHole,
  getHolesForVersion,
  getLatestCourseVersion,
  updateHoleNotes,
  updateHoleWaypoints
} from "../lib/courseRepo";
import {
  completeRound,
  correctShot,
  getActiveRoundForCourse,
  getOrCreateRoundHole,
  recordShot,
  saveGreenMarks,
  saveHoleResult,
  setRoundHoleFairwayResult,
  setRoundHolePinLocation,
  startRound
} from "../lib/roundRepo";
import {
  addReviewFlag,
  clubIdForSerial,
  countCapturedSwings,
  recordClubTap,
  recordWatchCalibration,
  recordWatchLap,
  setReviewFlagStatus
} from "../lib/captureRepo";
import { armScanning, isNfcSupported } from "../lib/nfc";
import { ALL_LIES, LIE_LABELS, detectLie } from "../lib/lie";
import { classifyFairwayResult } from "../lib/fairway";
import { CourseMap, type DispersionEllipseSpec } from "../components/CourseMap";
import { GreenMap } from "../components/GreenMap";
import { HoleScoreSheet, ScorecardSheet, ShotSheet } from "../components/RoundSheets";
import { Icon, relativeToParLabel } from "../components/ui";
import { bearingDegrees, distanceMeters, distanceYards, fromDownrangeOffline } from "../lib/geo";
import { getClubDispersion } from "../lib/dispersion";
import { isGpsEnabled, isSimulationEnabled } from "../lib/settings";
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

/** How long a rail button must be held before it explains itself instead of firing. */
const TOOL_HINT_HOLD_MS = 450;

interface ToolHint {
  label: string;
  hint: string;
}

/**
 * A map rail button that describes itself on a long press. Phones never show `title`, so without
 * this the rail is a column of unlabelled glyphs. Holding shows the description and cancels the
 * button's action, so nothing fires by accident while you're reading it.
 */
function ToolButton({
  icon,
  label,
  hint,
  active,
  disabled,
  onPress,
  onHint
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
  onHint: (h: ToolHint | null) => void;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldRef = useRef(false);

  function clear() {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }
  useEffect(() => clear, []);

  return (
    <button
      className={`map-btn${active ? " is-active" : ""}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onPointerDown={() => {
        heldRef.current = false;
        clear();
        timerRef.current = setTimeout(() => {
          heldRef.current = true;
          onHint({ label, hint });
        }, TOOL_HINT_HOLD_MS);
      }}
      onPointerUp={() => {
        clear();
        // Give the hint a moment to be read before it clears.
        if (heldRef.current) setTimeout(() => onHint(null), 1400);
      }}
      onPointerLeave={() => {
        clear();
        if (heldRef.current) onHint(null);
      }}
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => {
        if (heldRef.current) return; // the hold explained it; don't also act on it
        onPress();
      }}
    >
      {icon}
    </button>
  );
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

  // --- Hole range: a round can be the full course, the front nine or the back nine. Rounds
  // recorded before nines existed carry no range and fall back to the whole course, which is
  // what they were. Navigation, the scorecard, the running score and "when is the round over"
  // all read from here rather than assuming 1..18. Declared early because most of the derived
  // round state below depends on it. ---
  const courseFirstHole = holes?.length ? Math.min(...holes.map((h) => h.number)) : 1;
  const courseLastHole = holes?.length ? Math.max(...holes.map((h) => h.number)) : 18;
  const courseHasBackNine = courseLastHole >= 18;
  const [pendingRange, setPendingRange] = useState<"full" | "front" | "back">("full");
  const [round, setRound] = useState<Round | null>(null);

  const activeRange = useMemo(() => {
    if (round) {
      return { start: round.startHole ?? courseFirstHole, end: round.endHole ?? courseLastHole };
    }
    if (pendingRange === "front") return { start: courseFirstHole, end: Math.min(9, courseLastHole) };
    if (pendingRange === "back") return { start: 10, end: courseLastHole };
    return { start: courseFirstHole, end: courseLastHole };
  }, [round, pendingRange, courseFirstHole, courseLastHole]);

  const firstHole = activeRange.start;
  const maxHoleNumber = activeRange.end;

  // Keep the viewed hole inside the active range — picking "back nine" pre-round should jump
  // straight to 10, and resuming a nine shouldn't strand you on a hole it doesn't include.
  useEffect(() => {
    setHoleNumber((n) => Math.min(Math.max(n, firstHole), maxHoleNumber));
  }, [firstHole, maxHoleNumber]);

  const holeFeatures = useLiveQuery(() => (currentHole ? getFeaturesForHole(currentHole.id) : []), [currentHole?.id]);
  const teeBoxes = useLiveQuery(
    () => (currentHole ? db.teeBoxes.where("holeId").equals(currentHole.id).toArray() : []),
    [currentHole?.id]
  );

  // --- Round state (the round itself is declared with the hole range above) ---
  const [clubs, setClubs] = useState<Club[]>([]);
  // Live mirror of `clubs` for imperative callbacks (NFC reads) that would
  // otherwise capture a stale array from the render they were armed in.
  const clubsRef = useRef<Club[]>([]);
  clubsRef.current = clubs;
  const [roundHoleId, setRoundHoleId] = useState<string | null>(null);
  const [openSheet, setOpenSheet] = useState<"shot" | "score" | "scorecard" | null>(null);
  // Latest GPS fix + its reported accuracy. Kept together so a recorded shot can carry honest
  // provenance (positionSource/accuracyM) instead of a bare coordinate of unknown quality.
  const lastPositionRef = useRef<{ point: LatLng; accuracyM: number | null } | null>(null);
  // Tracks pointerdown position on the map wrapper to distinguish a tap (dismisses the notes
  // popover) from a drag/pan (which also ends in a native click but shouldn't dismiss anything).
  const mapPointerDownRef = useRef<{ x: number; y: number } | null>(null);

  // --- Map controls, lifted so the tool rail can drive CourseMap externally ---
  const [settingTarget, setSettingTarget] = useState(false);
  const [toolHint, setToolHint] = useState<ToolHint | null>(null);
  const [centerDistance, setCenterDistance] = useState<number | null>(null);
  const [waterWarningYards, setWaterWarningYards] = useState<number | null>(null);

  // --- Dispersion overlay: pick a club, show its (manual or actual, per the club's own flag)
  // shot ellipse. CourseMap centers it on the dot in play for the current shot. ---
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

  // --- Capture streams: NFC club taps + screen wake lock + green marking ---
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showToast(msg: string) {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => setToast(null), 2500);
  }
  useEffect(() => () => (toastTimerRef.current ? clearTimeout(toastTimerRef.current) : undefined), []);

  const [nfcActive, setNfcActive] = useState(false);
  const nfcStopRef = useRef<(() => void) | null>(null);
  // Arms continuous tag scanning for the round. Must be called from a user gesture (Start round,
  // or the NFC chip after a mid-round reload). Every read = one ClubTap row + a toast —
  // deliberately NO sheet, NO confirmation: tap the bag, keep walking.
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
            // Ref, not the render-time value: this callback is armed once at round start and
            // would otherwise pin every tap of the round to the first hole's id.
            roundHoleId: roundHoleIdRef.current,
            clubId,
            serialNumber: serial,
            at,
            point: fix?.point ?? null,
            accuracyM: fix?.accuracyM ?? null
          });
          showToast(clubsRef.current.find((c) => c.id === clubId)?.name ?? "Club logged");
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

  // Screen wake lock while a round is active: NFC only delivers while the page is visible, so the
  // screen staying on IS the capture reliability story. Re-acquired on visibilitychange because
  // the OS silently releases it whenever the page is hidden.
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
        // Denied (battery saver etc.) — the indicator simply stays off.
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
  // The tee set is a once-per-round decision, so the selector disappears for good once it's made
  // and never comes back hole to hole. (It also stays hidden once the round is under way.)
  const [teeSelectorClosed, setTeeSelectorClosed] = useState(false);
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
  // resolvedRoundHole seeds pinDataReady/currentRoundHole with the SAME row getOrCreateRoundHole
  // just resolved, so they don't have to wait for the separate live query to independently catch
  // up. Without this, starting a round briefly flips pinDataReady false for a render or two,
  // which unmounts CourseMap and silently wipes any measure dots already placed.
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

  // Live mirror for imperative callbacks (the NFC reader is armed once per round, so reading
  // roundHoleId from its closure would attribute every tap to the hole you started on).
  const roundHoleIdRef = useRef<string | null>(null);
  roundHoleIdRef.current = roundHoleId;

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
  const manualShotCount = shots?.filter((s) => s.reconciliation !== "green_mark").length ?? 0;

  // Swings signalled on this hole through the capture streams (watch lap presses and NFC club
  // tags). These don't become Shot rows until the watch file is ingested and reconciled after the
  // round, so without counting them here the live score would ignore every stroke played the way
  // the app is actually meant to be used.
  const capturedLaps = useLiveQuery(
    () => (roundHoleId ? db.watchLaps.where("roundId").equals(round?.id ?? "").toArray() : []),
    [roundHoleId, round?.id]
  );
  const capturedTaps = useLiveQuery(
    () => (roundHoleId ? db.clubTaps.where("roundId").equals(round?.id ?? "").toArray() : []),
    [roundHoleId, round?.id]
  );
  const capturedSwings = useMemo(() => {
    if (!roundHoleId) return 0;
    return countCapturedSwings(
      (capturedLaps ?? []).filter((l) => l.roundHoleId === roundHoleId),
      (capturedTaps ?? []).filter((t) => t.roundHoleId === roundHoleId)
    );
  }, [capturedLaps, capturedTaps, roundHoleId]);

  // The stroke count the whole screen works from: hand-entered shots plus captured swings.
  const shotCount = manualShotCount + capturedSwings;

  // All roundHoles played so far this round, for the score badge + scorecard sheet.
  const allRoundHoles = useLiveQuery(
    () => (round ? db.roundHoles.where("roundId").equals(round.id).toArray() : []),
    [round?.id]
  );
  const scorecardEntries = useMemo(() => {
    if (!holes) return [];
    return holes
      .filter((h) => h.number >= activeRange.start && h.number <= activeRange.end)
      .map((h) => ({
        holeNumber: h.number,
        par: h.par,
        score: allRoundHoles?.find((rh) => rh.holeId === h.id)?.score ?? null
      }));
  }, [holes, allRoundHoles, activeRange.start, activeRange.end]);
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
    // few renders after currentHole.id changes. A plain truthy check doesn't catch this since
    // the stale data is real, just for the wrong hole — and CourseMap reads initialTarget once,
    // at mount, so trusting it would lock the new hole's camera onto the old hole's green.
    if (!holeFeatures.every((f) => f.holeId === currentHole.id)) return null;
    const green =
      holeFeatures.find((f) => f.featureType === "green" && f.geometry.type === "Polygon") ??
      holeFeatures.find((f) => f.featureType === "fairway" && f.geometry.type === "Polygon");
    return green ? centroidLatLng(green.geometry as GeoJSON.Polygon) : null;
  }, [holeFeatures, currentHole]);

  const activeTarget = currentRoundHole?.pinLocation ?? greenCentroid;
  const pinDataReady = !roundHoleId || currentRoundHole !== undefined;

  // Excludes the generic "Tee" fallback name whenever real colour sets exist.
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
    // Same stale-data guard as greenCentroid above.
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

  // Suggested first layup dot: nothing on Par 3s or holes under 300y; otherwise prefers a point
  // 275y down the tee->green line if it lands in the fairway, else the midpoint of the segment
  // where that line actually crosses the fairway polygon, else the nearest fairway edge.
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

    const boundary = turf.polygonToLine(fairwayPolygon) as GeoJSON.Feature<GeoJSON.LineString | GeoJSON.MultiLineString>;
    const nearest = turf.nearestPointOnLine(boundary, turf.point([fallbackOrigin.lng, fallbackOrigin.lat]));
    const [lng, lat] = nearest.geometry.coordinates;
    return { lat, lng };
  }, [holeFeatures, currentHole, fallbackOrigin, greenCentroid]);


  // --- Green marking ---
  const [greenMapOpen, setGreenMapOpen] = useState(false);
  const pendingHoleOutRef = useRef(false);
  // Putt count straight from the marking screen. The live query behind currentRoundHole hasn't
  // necessarily caught up by the time the score sheet mounts, and HoleScoreSheet seeds its state
  // once — so pass the number we just wrote rather than reading it back.
  const [justMarkedPutts, setJustMarkedPutts] = useState<number | null>(null);

  async function handleGreenFinish(pin: LatLng, puttStarts: LatLng[]) {
    if (!roundHoleId) return;
    await saveGreenMarks({
      roundHoleId,
      pin,
      puttStarts,
      detectLieAt: (p) => detectLie(p, holeFeatures ?? [])
    });
    setJustMarkedPutts(puttStarts.length);
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
    showToast("Now press the watch lap button");
  }

  // --- Simulation ("couch") mode: rehearse a round indoors. The position is placed by tapping
  // the map, and the two capture streams get on-screen stand-ins for the watch lap button and an
  // NFC club tap. Both write the SAME rows the real hardware would, so what's rehearsed here is
  // genuinely the flow that runs on the course — including reconciliation afterwards. ---
  const [simulationMode] = useState(isSimulationEnabled);
  const [simPosition, setSimPosition] = useState<LatLng | null>(null);
  const [placingSimPosition, setPlacingSimPosition] = useState(false);
  const [simClubPickerOpen, setSimClubPickerOpen] = useState(false);
  const [simCounts, setSimCounts] = useState({ laps: 0, taps: 0 });

  // Start each hole standing on its tee, the way you would in reality.
  useEffect(() => {
    if (simulationMode) setSimPosition(fallbackOrigin ?? null);
  }, [simulationMode, currentHole?.id, fallbackOrigin?.lat, fallbackOrigin?.lng]);

  async function handleSimLap() {
    if (!round || !simPosition) return;
    await recordWatchLap(round.id, simPosition, null, roundHoleId);
    setSimCounts((c) => ({ ...c, laps: c.laps + 1 }));
    showToast("Lap recorded");
  }

  async function handleSimTap(club: Club) {
    if (!round || !simPosition) return;
    await recordClubTap({
      roundId: round.id,
      roundHoleId,
      clubId: club.id,
      serialNumber: `sim-${club.name}`,
      at: new Date(),
      point: simPosition,
      accuracyM: 3
    });
    setSimCounts((c) => ({ ...c, taps: c.taps + 1 }));
    setSimClubPickerOpen(false);
    showToast(`Tagged ${club.name}`);
  }

  // --- Next-tee prompt: open flags on the just-completed hole surface as a compact card. Never
  // blocks play; "Later" defers to the end-of-round queue (dismissed ≠ resolved). ---
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
  function fixFlagNow() {
    if (!nextTeeFlag) return;
    if (nextTeeFlag.type === "score_mismatch") {
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

  async function handleStartRound() {
    if (!courseVersion) return;
    const r = await startRound(courseVersion.id, { startHole: activeRange.start, endHole: activeRange.end });
    setRound(r);
    setHoleNumber(activeRange.start);
    // This click IS the user gesture Web NFC's permission prompt needs — arm here, not in an effect.
    armNfc(r.id);
  }

  async function handleTargetChange(point: LatLng) {
    if (!roundHoleId) return;
    await setRoundHolePinLocation(roundHoleId, point);
  }

  async function handleSaveShot(clubId: string | null, lie: Lie) {
    if (!roundHoleId) return;
    // Fall back to the tee box when GPS hasn't locked yet (indoors, cold start) so the shot still
    // saves rather than blocking — but flagged as "tee_fallback" so distance statistics can
    // exclude it instead of treating a guessed coordinate as a real fix.
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

    // Live balance check (feeds the next-tee card). Only when shots were actually being recorded
    // — a score-only hole shouldn't nag about "0 swings".
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
    setJustMarkedPutts(null);

    setOpenSheet(null);
    // The round ends at the last hole of the range being played — hole 9 for a front nine, not 18.
    if (holeNumber < maxHoleNumber) {
      setHoleNumber(holeNumber + 1);
    } else if (round) {
      await completeRound(round.id);
      stopNfc();
      setRound(null);
      showToast("Round complete");
    }
  }

  const detectedLie = useMemo(() => {
    if (!lastPositionRef.current || !holeFeatures?.length) return "rough" as const;
    return detectLie(lastPositionRef.current.point, holeFeatures);
  }, [openSheet, holeFeatures]); // recompute when the sheet opens, at the position you're standing

  const frontDistance = centerDistance !== null ? Math.max(0, centerDistance - GREEN_HALF_DEPTH_YARDS) : null;
  const backDistance = centerDistance !== null ? centerDistance + GREEN_HALF_DEPTH_YARDS : null;
  const greenMarked = !!currentRoundHole?.pinLocation;

  return (
    <div className="map-root">
      <Link to="/" className="map-btn glass" style={{ position: "absolute", top: "calc(12px + var(--safe-t))", left: 12, zIndex: 4 }} aria-label="Exit round">
        <Icon.back size={19} />
      </Link>

      {!isDemo && currentHole && (
        <div className="hole-bar glass">
          <button
            className="hole-bar__nav"
            onClick={() => setHoleNumber((n) => Math.max(firstHole, n - 1))}
            disabled={holeNumber <= firstHole}
            aria-label="Previous hole"
          >
            ‹
          </button>
          <span className="hole-bar__label">
            {getHoleOrdinal(currentHole.number)}
            <span className="hole-bar__par">
              {" · "}Par {currentHole.par}
              {currentHole.defaultYardage ? ` · ${currentHole.defaultYardage}y` : ""}
            </span>
          </span>
          <button
            className="hole-bar__nav"
            onClick={() => setHoleNumber((n) => Math.min(maxHoleNumber, n + 1))}
            disabled={holeNumber >= maxHoleNumber}
            aria-label="Next hole"
          >
            ›
          </button>
        </div>
      )}

      {!isDemo && currentHole && (
        <div className="tool-rail glass">
          <ToolButton
            icon={<Icon.target size={19} />}
            label="Set target"
            hint="Tap the map to move the pin. Distances update to wherever you put it."
            active={settingTarget}
            onPress={() => setSettingTarget((s) => !s)}
            onHint={setToolHint}
          />
          <ToolButton
            icon={<Icon.note size={19} />}
            label="Hole notes"
            hint="Notes for this hole — they save automatically and reload every time you play here."
            active={notesOpen}
            onPress={() => setNotesOpen((v) => !v)}
            onHint={setToolHint}
          />
          <ToolButton
            icon={<Icon.ellipse size={19} />}
            label="Shot dispersion"
            hint="Overlay a club's shot pattern on the hole, centred on what you're aiming at."
            active={!!dispersionEllipse}
            onPress={() => setDispersionPickerOpen((v) => !v)}
            onHint={setToolHint}
          />
          {round && (
            <ToolButton
              icon={<Icon.pin size={19} />}
              label="Mark green"
              hint="Mark where the pin was and where each putt started. Sets your putt count."
              active={greenMarked}
              disabled={!roundHoleId}
              onPress={() => setGreenMapOpen(true)}
              onHint={setToolHint}
            />
          )}
          {round && !round.watchCalibrationAt && (
            <ToolButton
              icon={<Icon.watch size={19} />}
              label="Calibrate watch"
              hint="Tap this and press the watch lap button at the same moment, so the two clocks line up."
              onPress={handleCalibrateWatch}
              onHint={setToolHint}
            />
          )}
          <ToolButton
            icon={<span style={{ fontSize: 14, fontWeight: 800 }}>{round ? relativeToParLabel(relativeScore) : "–"}</span>}
            label="Scorecard"
            hint="Your scorecard for this round so far."
            onPress={() => setOpenSheet("scorecard")}
            onHint={setToolHint}
          />
        </div>
      )}

      {/* Long-press hint. `title` never appears on a phone, so holding a rail button explains it
          here instead — and the hold suppresses the button's own action. */}
      {toolHint && (
        <div
          className="glass"
          style={{
            position: "absolute",
            top: "calc(66px + var(--safe-t))",
            right: 62,
            zIndex: 7,
            maxWidth: "min(250px, 66vw)",
            borderRadius: 12,
            padding: "10px 13px",
            pointerEvents: "none"
          }}
        >
          <div className="bold small mb-1">{toolHint.label}</div>
          <div className="tiny dim" style={{ lineHeight: 1.45 }}>
            {toolHint.hint}
          </div>
        </div>
      )}

      {!isDemo && toast && <div className="toast glass">{toast}</div>}

      {!isDemo && currentHole && notesOpen && (
        <div className="popover glass" style={{ top: "calc(66px + var(--safe-t))", right: 64, width: "min(290px, 76vw)" }}>
          <textarea
            className="field"
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            placeholder="Notes for this hole — yardages, strategy, hazards…"
            rows={3}
            autoFocus
          />
        </div>
      )}

      {!isDemo && currentHole && dispersionPickerOpen && (
        <div
          className="popover glass"
          style={{ top: "calc(66px + var(--safe-t))", right: 64, width: 200, maxHeight: "min(340px, 52vh)", overflowY: "auto" }}
        >
          <div className="row row--between mb-2">
            <span className="section__title">Dispersion</span>
            <button className="map-btn" style={{ width: 26, height: 26 }} onClick={() => setDispersionPickerOpen(false)} aria-label="Close">
              <Icon.close size={14} />
            </button>
          </div>
          <div className="stack" style={{ gap: 6 }}>
            <button className={`chip chip--sm${activeClubId === null ? " chip--active" : ""}`} onClick={() => setActiveClubId(null)}>
              None
            </button>
            {clubs.map((c) => (
              <button
                key={c.id}
                className={`chip chip--sm${activeClubId === c.id ? " chip--active" : ""}`}
                onClick={() => setActiveClubId(c.id)}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Tap-away dismissal: a genuine TAP (minimal movement between pointerdown and pointerup) on
          the map itself closes the notes popover. Tracked via pointer position rather than a plain
          onClick so panning the map — which still ends in a native click — doesn't dismiss it. The
          sheets have their own backdrop, so this only needs to cover the popovers. */}
      <div
        onPointerDown={(e) => {
          mapPointerDownRef.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={(e) => {
          const start = mapPointerDownRef.current;
          mapPointerDownRef.current = null;
          if (!start || (!notesOpen && !dispersionPickerOpen)) return;
          if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < TAP_MOVE_TOLERANCE_PX) {
            setNotesOpen(false);
            setDispersionPickerOpen(false);
          }
        }}
        style={{ position: "absolute", inset: 0 }}
      >
        {isDemo ? (
          <CourseMap />
        ) : currentHole && greenCentroid && fallbackOrigin && pinDataReady ? (
          // Gated on the derived values themselves, not just on the queries having "resolved" —
          // Dexie's live-query hook briefly emits a genuinely-empty [] for each before converging
          // on the real rows, so a resolved-vs-undefined check opens one render too early.
          // CourseMap's map-init effect only runs once, so mounting early would permanently lock
          // the camera onto the flat fallback and miss a pin saved earlier this round.
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
            hideInternalHud
            dispersionEllipse={dispersionEllipse}
            autoLayupPoint={fairwayLayupPoint}
            currentShotNumber={shotCount + 1}
            gpsEnabled={gpsEnabled}
            initialWaypoints={currentHole.waypoints}
            onSaveWaypoints={async (points) => {
              await updateHoleWaypoints(currentHole.id, points);
              showToast(points.length ? "Line saved to this hole" : "Line cleared");
            }}
            simulationMode={simulationMode}
            simulatedPosition={simPosition}
            placingSimPosition={placingSimPosition}
            onSimPositionPlaced={(p) => {
              setSimPosition(p);
              setPlacingSimPosition(false);
            }}
          />
        ) : (
          <div className="row" style={{ height: "100%", justifyContent: "center" }}>
            <span className="spinner" />
            <span className="dim">Loading course…</span>
          </div>
        )}
      </div>

      {/* Bottom-left stack: distances, note preview, and (right-aligned) capture status. */}
      {!isDemo && currentHole && (
        <div className="round-stack">
          <div className="hud glass">
            <div className="hud__label">To pin</div>
            <div className="row" style={{ alignItems: "baseline", gap: 0 }}>
              <span className="hud__value">{centerDistance ?? "—"}</span>
              {centerDistance !== null && <span className="hud__unit">yd</span>}
            </div>
            <div className="hud__split">
              <div className="hud__split-item">
                <span className="hud__label">Front</span>
                <span className="hud__split-value">{frontDistance ?? "—"}</span>
              </div>
              <div className="hud__split-item">
                <span className="hud__label">Back</span>
                <span className="hud__split-value">{backDistance ?? "—"}</span>
              </div>
            </div>
            {waterWarningYards !== null && (
              <div className="hud__warn">
                <Icon.warn size={15} /> Water {waterWarningYards}y
              </div>
            )}
          </div>

          {!notesOpen && currentHole.notes && (
            <button className="notes-preview glass" onClick={() => setNotesOpen(true)}>
              {currentHole.notes}
            </button>
          )}

          {round && (
            <div className="status-rail">
              <button
                className={`status-chip glass${nfcActive ? " status-chip--on" : ""}`}
                onClick={() => (nfcActive ? stopNfc() : armNfc(round.id))}
                title={
                  isNfcSupported()
                    ? nfcActive
                      ? "NFC club tags: scanning (tap to stop)"
                      : "NFC club tags: off (tap to arm)"
                    : "Web NFC not supported on this device"
                }
              >
                <Icon.tag size={13} /> {nfcActive ? "NFC" : "NFC off"}
              </button>
              {wakeLockHeld && (
                <span className="status-chip glass status-chip--on" title="Screen staying awake so NFC taps register">
                  <Icon.bolt size={13} /> Awake
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Pre-round setup: tee set (asked once, then gone for good) and how many holes. */}
      {!isDemo && currentHole && !round && (
        <div
          className="glass"
          style={{
            position: "absolute",
            right: 12,
            bottom: "calc(var(--round-bar-h, 76px) + 10px)",
            zIndex: 4,
            borderRadius: 16,
            padding: 10,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            alignItems: "flex-end"
          }}
        >
          {uniqueTeeNames.length > 0 && !teeSelectorClosed && (
            <select
              className="field"
              style={{ padding: "7px 12px", borderRadius: 999 }}
              value={selectedTeeName}
              onChange={(e) => handleTeeChange(e.target.value)}
              aria-label="Tee set"
            >
              <option value="">Backmost tee</option>
              {uniqueTeeNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
          {courseHasBackNine && (
            <div className="chip-row" style={{ justifyContent: "flex-end" }}>
              {([
                { key: "full", label: "18", start: courseFirstHole },
                { key: "front", label: "Front 9", start: courseFirstHole },
                { key: "back", label: "Back 9", start: 10 }
              ] as const).map((opt) => (
                <button
                  key={opt.key}
                  className={`chip chip--sm${pendingRange === opt.key ? " chip--active" : ""}`}
                  onClick={() => {
                    setPendingRange(opt.key);
                    // Jump to the range's first hole. The clamp effect alone would only nudge you
                    // to the nearest in-range hole, so choosing "Front 9" from the 10th tee left
                    // you on 9 rather than back at the 1st.
                    setHoleNumber(opt.start);
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Simulation panel — only ever present when the Settings toggle is on. */}
      {!isDemo && currentHole && simulationMode && (
        <div
          className="glass"
          style={{
            position: "absolute",
            left: 12,
            top: "calc(66px + var(--safe-t))",
            zIndex: 4,
            borderRadius: 14,
            padding: 9,
            display: "flex",
            flexDirection: "column",
            gap: 7,
            width: 132
          }}
        >
          <div className="row row--between">
            <span className="section__title" style={{ color: "var(--warn)" }}>
              Simulate
            </span>
            {(simCounts.laps > 0 || simCounts.taps > 0) && (
              <span className="tiny faint num">
                {simCounts.laps}/{simCounts.taps}
              </span>
            )}
          </div>
          <button
            className={`btn btn--sm${placingSimPosition ? " btn--primary" : ""}`}
            style={{ width: "100%" }}
            onClick={() => setPlacingSimPosition((v) => !v)}
          >
            {placingSimPosition ? "Tap map…" : "Move me"}
          </button>
          {round ? (
            <>
              <button className="btn btn--sm" style={{ width: "100%" }} onClick={handleSimLap} disabled={!simPosition}>
                <Icon.watch size={14} /> Lap
              </button>
              <button
                className={`btn btn--sm${simClubPickerOpen ? " btn--primary" : ""}`}
                style={{ width: "100%" }}
                onClick={() => setSimClubPickerOpen((v) => !v)}
                disabled={!simPosition}
              >
                <Icon.tag size={14} /> Tag club
              </button>
            </>
          ) : (
            <div className="tiny faint">Start the round to log laps and tags.</div>
          )}
        </div>
      )}

      {!isDemo && simClubPickerOpen && (
        <div
          className="popover glass"
          style={{ top: "calc(210px + var(--safe-t))", left: 12, width: 150, maxHeight: "min(300px, 44vh)", overflowY: "auto", zIndex: 6 }}
        >
          <div className="section__title mb-2">Which club?</div>
          <div className="stack" style={{ gap: 5 }}>
            {clubs.map((c) => (
              <button key={c.id} className="chip chip--sm" onClick={() => handleSimTap(c)}>
                {c.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {!isDemo && round && nextTeeFlag && (
        <div className="prompt-card glass">
          <div className="row mb-2" style={{ alignItems: "flex-start", gap: 8 }}>
            <span className="warn" style={{ display: "flex", flex: "none", marginTop: 1 }}>
              <Icon.warn size={17} />
            </span>
            <span className="small grow">{nextTeeFlag.detail}</span>
          </div>
          {nextTeeFlag.type === "ambiguous_lie" && flaggedShot && (
            <div className="chip-row mb-2">
              {ALL_LIES.filter((l) => l !== "tee").map((l) => (
                <button
                  key={l}
                  className={`chip chip--sm${flaggedShot.lieStart === l ? " chip--active" : ""}`}
                  onClick={() => fixFlagLie(l)}
                >
                  {LIE_LABELS[l]}
                </button>
              ))}
            </div>
          )}
          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            {nextTeeFlag.type === "score_mismatch" && (
              <button className="btn btn--sm btn--primary" onClick={fixFlagNow}>
                Fix now
              </button>
            )}
            <button className="btn btn--sm btn--ghost" onClick={dismissNextTeeFlags}>
              Later
            </button>
          </div>
        </div>
      )}

      {!isDemo && currentHole && (
        <div className="round-bar">
          <div className="round-bar__player">
            <div className="avatar">{PLAYER_INITIALS}</div>
            <div className="grow">
              <div className="round-bar__name">{PLAYER_NAME}</div>
              <div className="round-bar__score">
                {!round ? (
                  "Not started"
                ) : (
                  <>
                    {relativeToParLabel(relativeScore)}
                    {shotCount > 0 && (
                      <span className="faint">
                        {" · "}
                        {shotCount} on this hole
                        {/* Where the count came from, so tagged strokes and hand-entered ones are
                            never silently conflated. */}
                        {capturedSwings > 0 && manualShotCount > 0
                          ? ` (${capturedSwings} tagged, ${manualShotCount} manual)`
                          : capturedSwings > 0
                            ? " (tagged)"
                            : ""}
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {!round ? (
              <button className="btn btn--primary" onClick={handleStartRound}>
                <Icon.play size={16} /> Start round
              </button>
            ) : (
              <>
                <button className="btn btn--sm" onClick={() => setOpenSheet("shot")} disabled={!roundHoleId}>
                  <Icon.golfer size={15} /> Shot {shotCount + 1}
                </button>
                <button
                  className="btn btn--sm btn--primary"
                  onClick={() => {
                    // Force the green-marking screen at hole-out when the hole has no marks yet
                    // — the score sheet opens right after Finish.
                    if (!greenMarked) {
                      pendingHoleOutRef.current = true;
                      setGreenMapOpen(true);
                    } else {
                      setOpenSheet("score");
                    }
                  }}
                  disabled={!roundHoleId}
                >
                  <Icon.flag size={15} /> Hole out
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
          markedPutts={justMarkedPutts ?? (greenMarked ? currentRoundHole?.putts : null)}
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
