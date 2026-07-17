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
  setRoundHolePinLocation,
  startRound
} from "../lib/roundRepo";
import { detectLie } from "../lib/lie";
import { CourseMap, OUTDOORS_STYLE, SATELLITE_STYLE, type DispersionEllipseSpec } from "../components/CourseMap";
import { HoleScoreSheet, ScorecardSheet, ShotSheet, relativeToParLabel } from "../components/RoundSheets";
import { distanceMeters, distanceYards, nearestPointOnSegment } from "../lib/geo";
import { getClubDispersion } from "../lib/dispersion";
import type { Club, FairwayResult, LatLng, Lie, Round } from "../types/domain";

const GREENSIDE_BUNKER_MAX_YARDS = 40;
const FAR_FROM_HOLE_METERS = 300;
const GREEN_HALF_DEPTH_YARDS = 15;
const PACE_TICK_MS = 15000;
const TEE_PREFERENCE_KEY = "caddyshot_tee_preference";

// Personal, single-user app — no auth/profile system exists (or is needed) to derive this from.
const PLAYER_NAME = "Colin";
const PLAYER_INITIALS = "CH";

function centroidLatLng(geom: GeoJSON.Polygon): LatLng {
  const [lng, lat] = turf.centroid(turf.feature(geom)).geometry.coordinates;
  return { lat, lng };
}

function getHoleOrdinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}TH`;
  switch (n % 10) {
    case 1:
      return `${n}ST`;
    case 2:
      return `${n}ND`;
    case 3:
      return `${n}RD`;
    default:
      return `${n}TH`;
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
  const lastPositionRef = useRef<LatLng | null>(null);

  // --- Grint-style map controls, lifted so the right-side pill can drive CourseMap externally ---
  const [settingTarget, setSettingTarget] = useState(false);
  const [mapStyle, setMapStyle] = useState(SATELLITE_STYLE);
  const [centerDistance, setCenterDistance] = useState<number | null>(null);
  const [waterWarningYards, setWaterWarningYards] = useState<number | null>(null);

  // --- Dispersion overlay: pick a club, show its (manual or actual, per the club's own flag)
  // shot ellipse centered on the target pin ---
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
  function handleTeeChange(name: string) {
    setSelectedTeeName(name);
    if (typeof localStorage === "undefined") return;
    if (name) localStorage.setItem(TEE_PREFERENCE_KEY, name);
    else localStorage.removeItem(TEE_PREFERENCE_KEY);
  }

  // --- Pace-of-play timer: minutes elapsed since arriving at the current hole ---
  const holeStartRef = useRef<number>(Date.now());
  const [elapsedMinutes, setElapsedMinutes] = useState(0);
  useEffect(() => {
    holeStartRef.current = Date.now();
    setElapsedMinutes(0);
  }, [currentHole?.id]);
  useEffect(() => {
    const interval = setInterval(() => setElapsedMinutes(Math.floor((Date.now() - holeStartRef.current) / 60000)), PACE_TICK_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (isDemo || !courseId) return;
    getActiveRoundForCourse(courseId).then((r) => setRound(r ?? null));
    ensureDefaultClubs().then(setClubs);
  }, [isDemo, courseId]);

  // A RoundHole row is created lazily the first time you interact with a hole during a round.
  useEffect(() => {
    setRoundHoleId(null);
    if (!round || !currentHole) return;
    getOrCreateRoundHole(round.id, currentHole.id).then((rh) => setRoundHoleId(rh.id));
  }, [round, currentHole?.id]);

  // Live so a dragged/tapped pin (persisted via onTargetChange below) is picked back up
  // correctly if you navigate away from this hole and back.
  const currentRoundHole = useLiveQuery(
    () => (roundHoleId ? db.roundHoles.get(roundHoleId) : undefined),
    [roundHoleId]
  );

  const shots = useLiveQuery(
    () => (roundHoleId ? db.shots.where("roundHoleId").equals(roundHoleId).toArray() : []),
    [roundHoleId]
  );
  const shotCount = shots?.length ?? 0;

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
    if (!holeFeatures?.length || !currentHole) return null;
    // Dexie's live-query hook keeps returning the PREVIOUS hole's already-resolved rows for a
    // few renders after currentHole.id changes, before the new query catches up — a plain
    // truthy/non-empty check doesn't catch this since the stale data is real, just for the
    // wrong hole. CourseMap only reads its initialTarget prop once at mount, and remounts
    // immediately on hole change (key={currentHole.id}), so trusting mismatched data here would
    // permanently lock the new hole's camera onto the old hole's green.
    if (!holeFeatures.every((f) => f.holeId === currentHole.id)) return null;
    const green = holeFeatures.find((f) => f.featureType === "green") ?? holeFeatures.find((f) => f.featureType === "fairway");
    return green ? centroidLatLng(green.geometry) : null;
  }, [holeFeatures, currentHole]);

  // A custom dragged/tapped pin overrides the green centroid default, once one's been set for
  // this hole this round.
  const activeTarget = currentRoundHole?.pinLocation ?? greenCentroid;
  // Whether pin data is safe to consider "resolved": if a round hole exists (roundHoleId set),
  // wait for its row to actually load before mounting CourseMap, so a pin saved earlier in this
  // round isn't missed — CourseMap only reads its initialTarget prop once, at mount, so mounting
  // before this resolves would permanently lock onto the green centroid instead. Not needed
  // pre-round (roundHoleId null), when there's no pin concept yet.
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

  // Suggested first layup dot: the fairway centroid, projected onto the tee->green line (the
  // closest thing this app has to a real hole centerline at round-time — see DESIGN.md). Same
  // stale-hole-data guard as greenCentroid/fallbackOrigin above, since CourseMap only acts on
  // this once per mount.
  const fairwayLayupPoint = useMemo(() => {
    if (!holeFeatures?.length || !currentHole || !fallbackOrigin || !greenCentroid) return null;
    if (!holeFeatures.every((f) => f.holeId === currentHole.id)) return null;
    const fairway = holeFeatures.find((f) => f.featureType === "fairway");
    if (!fairway) return null;
    const centroid = centroidLatLng(fairway.geometry);
    return nearestPointOnSegment(fallbackOrigin, greenCentroid, centroid).point;
  }, [holeFeatures, currentHole, fallbackOrigin, greenCentroid]);

  const maxHoleNumber = holes?.length ? Math.max(...holes.map((h) => h.number)) : 18;

  async function handleStartRound() {
    if (!courseVersion) return;
    const r = await startRound(courseVersion.id);
    setRound(r);
  }

  async function handleTargetChange(point: LatLng) {
    if (!roundHoleId) return;
    await setRoundHolePinLocation(roundHoleId, point);
  }

  async function handleSaveShot(clubId: string | null, lie: Lie) {
    if (!roundHoleId) return;
    // Fall back to the tee box when GPS hasn't locked yet (indoors, cold start) so the shot
    // still saves with a usable coordinate for strokes-gained baselines, rather than blocking.
    const point = lastPositionRef.current ?? fallbackOrigin;
    if (!point) return;
    const resolvedLie: Lie =
      lie === "bunker_greenside" && greenCentroid && distanceYards(point, greenCentroid) > GREENSIDE_BUNKER_MAX_YARDS
        ? "bunker_fairway"
        : lie;
    await recordShot({ roundHoleId, clubId, point, lie: resolvedLie });
    setOpenSheet(null);
  }

  async function handleSaveHole(
    score: number,
    putts: number,
    puttDistancesFeet: (number | null)[],
    fairwayResult: FairwayResult | null
  ) {
    if (!roundHoleId) return;
    await saveHoleResult({ roundHoleId, score, putts, puttDistancesFeet, fairwayResult, holeOutPoint: greenCentroid });
    setOpenSheet(null);
    if (holeNumber < maxHoleNumber) {
      setHoleNumber(holeNumber + 1);
    } else if (round) {
      await completeRound(round.id);
      setRound(null);
    }
  }

  const detectedLie = useMemo(() => {
    if (!lastPositionRef.current || !holeFeatures?.length) return "rough" as const;
    return detectLie(lastPositionRef.current, holeFeatures);
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
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 19, fontWeight: 700 }}>⛳ {getHoleOrdinal(currentHole.number)}</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              Par {currentHole.par}
              {currentHole.defaultYardage ? ` · ${currentHole.defaultYardage} Yards` : ""}
            </div>
          </div>
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
            <span style={{ fontSize: 18, fontWeight: 700 }}>{centerDistance ?? "—"}</span>
          </div>
          <div style={distanceRowStyle}>
            <span style={distanceLabelStyle}>FRONT</span>
            <span>{frontDistance ?? "—"}</span>
          </div>
          <div style={paceTimerStyle}>
            {elapsedMinutes}m · Hole {currentHole.number}
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
          >
            🎯
          </button>
          <button
            onClick={() => setMapStyle((s) => (s === SATELLITE_STYLE ? OUTDOORS_STYLE : SATELLITE_STYLE))}
            style={pillButtonStyle}
            aria-label="Toggle map style"
          >
            🗺️
          </button>
          <button
            onClick={() => setNotesOpen((v) => !v)}
            style={{ ...pillButtonStyle, ...(notesOpen ? pillButtonActiveStyle : {}) }}
            aria-label="Hole notes"
          >
            📝
          </button>
          <button onClick={() => setOpenSheet("scorecard")} style={pillButtonStyle} aria-label="Scorecard">
            📋
          </button>
          <button
            onClick={() => setDispersionPickerOpen((v) => !v)}
            style={{ ...pillButtonStyle, ...(dispersionEllipse ? pillButtonActiveStyle : {}) }}
            aria-label="Dispersion overlay"
          >
            📐
          </button>
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

      {!isDemo && currentHole && dispersionPickerOpen && (
        <div style={clubPickerStyle}>
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
          onPositionChange={(p) => {
            lastPositionRef.current = p;
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
        />
      ) : (
        <div style={{ padding: 24, color: "#eef2ef" }}>Loading course…</div>
      )}

      {!isDemo && currentHole && !round && uniqueTeeNames.length > 0 && (
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

      {!isDemo && currentHole && (
        <div style={bottomBarStyle}>
          <div style={profileRowStyle}>
            <div style={avatarStyle}>{PLAYER_INITIALS}</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{PLAYER_NAME}</div>
              <div style={{ fontSize: 11, opacity: 0.7 }}>{round ? relativeToParLabel(relativeScore) : "Not started"}</div>
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
                <button onClick={() => setOpenSheet("score")} disabled={!roundHoleId} style={roundButtonStyle}>
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
          onSave={handleSaveHole}
          onClose={() => setOpenSheet(null)}
        />
      )}
      {openSheet === "scorecard" && <ScorecardSheet entries={scorecardEntries} onClose={() => setOpenSheet(null)} />}
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

const holeHeaderStyle: React.CSSProperties = {
  position: "absolute",
  top: 12,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 2,
  display: "flex",
  alignItems: "center",
  gap: 12,
  background: "rgba(11,15,12,0.75)",
  color: "#eef2ef",
  padding: "6px 16px",
  borderRadius: 999
};

const navButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#eef2ef",
  fontSize: 22,
  padding: "0 6px",
  cursor: "pointer"
};

// Bottom-left, just above the bottom profile bar (same "bottom: 76" convention as
// teeSelectorStyle below) — stacks the green front/center/back distances, pace timer, and (when
// active) the water warning row in one translucent container.
const bottomLeftHudStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 76,
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
  lineHeight: 1.2
};

const distanceLabelStyle: React.CSSProperties = {
  fontSize: 10,
  opacity: 0.7,
  letterSpacing: 0.5
};

const paceTimerStyle: React.CSSProperties = {
  marginTop: 6,
  paddingTop: 6,
  borderTop: "1px solid rgba(255,255,255,0.2)",
  fontSize: 11,
  opacity: 0.8,
  whiteSpace: "nowrap"
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
  width: 40,
  height: 40,
  borderRadius: "50%",
  background: "#1a3a24",
  border: "1px solid #2f5c3d",
  color: "#eef2ef",
  fontSize: 17,
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
  padding: "4px 10px",
  fontSize: 13
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
  width: 34,
  height: 34,
  borderRadius: "50%",
  background: "#2f5c3d",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 13,
  fontWeight: 700
};

const roundButtonStyle: React.CSSProperties = {
  padding: "10px 16px",
  background: "#1a3a24",
  color: "#eef2ef",
  border: "1px solid #2f5c3d",
  borderRadius: 999,
  fontSize: 14,
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

const waterWarningRowStyle: React.CSSProperties = {
  marginTop: 6,
  paddingTop: 6,
  borderTop: "1px solid rgba(255,255,255,0.2)",
  fontSize: 12,
  fontWeight: 700,
  color: "#fca5a5",
  whiteSpace: "nowrap"
};

const clubPickerStyle: React.CSSProperties = {
  position: "absolute",
  top: 130,
  right: 12,
  zIndex: 2,
  display: "flex",
  flexDirection: "column",
  gap: 6,
  maxHeight: "min(320px, 50vh)",
  overflowY: "auto",
  background: "rgba(11,15,12,0.92)",
  border: "1px solid #2f5c3d",
  borderRadius: 12,
  padding: 8
};

const clubChipStyle: React.CSSProperties = {
  padding: "6px 12px",
  background: "#1a3a24",
  color: "#eef2ef",
  border: "1px solid #2f5c3d",
  borderRadius: 999,
  fontSize: 12,
  cursor: "pointer",
  whiteSpace: "nowrap"
};

const clubChipActiveStyle: React.CSSProperties = {
  background: "#f5d90a",
  color: "#111",
  border: "1px solid #f5d90a"
};
