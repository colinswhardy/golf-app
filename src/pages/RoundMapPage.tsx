import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import * as turf from "@turf/turf";
import { db } from "../lib/db";
import { ensureDefaultClubs, getFeaturesForHole, getHolesForVersion, getLatestCourseVersion } from "../lib/courseRepo";
import {
  completeRound,
  getActiveRoundForCourse,
  getOrCreateRoundHole,
  recordShot,
  saveHoleResult,
  startRound
} from "../lib/roundRepo";
import { detectLie } from "../lib/lie";
import { CourseMap, OUTDOORS_STYLE, SATELLITE_STYLE } from "../components/CourseMap";
import { HoleScoreSheet, ScorecardSheet, ShotSheet, relativeToParLabel } from "../components/RoundSheets";
import { distanceMeters, distanceYards } from "../lib/geo";
import type { Club, LatLng, Lie, Round } from "../types/domain";

const GREENSIDE_BUNKER_MAX_YARDS = 40;
const FAR_FROM_HOLE_METERS = 300;
const GREEN_HALF_DEPTH_YARDS = 15;
const PACE_TICK_MS = 15000;

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
    if (!holeFeatures?.length) return null;
    const green = holeFeatures.find((f) => f.featureType === "green") ?? holeFeatures.find((f) => f.featureType === "fairway");
    return green ? centroidLatLng(green.geometry) : null;
  }, [holeFeatures]);

  const fallbackOrigin = teeBoxes?.[0]?.location ?? null;
  const maxHoleNumber = holes?.length ? Math.max(...holes.map((h) => h.number)) : 18;

  async function handleStartRound() {
    if (!courseVersion) return;
    const r = await startRound(courseVersion.id);
    setRound(r);
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

  async function handleSaveHole(score: number, putts: number, puttDistancesFeet: (number | null)[]) {
    if (!roundHoleId) return;
    await saveHoleResult({ roundHoleId, score, putts, puttDistancesFeet, holeOutPoint: greenCentroid });
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
        <div style={leftCapsuleStyle}>
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
          <button onClick={() => setOpenSheet("scorecard")} style={pillButtonStyle} aria-label="Scorecard">
            📋
          </button>
        </div>
      )}

      {isDemo ? (
        <CourseMap />
      ) : currentHole && greenCentroid && fallbackOrigin ? (
        // Gated on the derived greenCentroid/fallbackOrigin themselves, not just on the
        // holeFeatures/teeBoxes queries having "resolved" — Dexie's live-query hook briefly
        // emits a genuinely-empty [] for each before converging on the real rows, so a
        // resolved-vs-undefined check opens one render too early. CourseMap's map-init effect
        // only runs once (on mount), so mounting before these are the real values would
        // permanently lock the camera onto the null/flat fallback instead of tee-facing-green.
        <CourseMap
          key={currentHole.id}
          initialTarget={greenCentroid}
          fallbackOrigin={fallbackOrigin}
          onPositionChange={(p) => {
            lastPositionRef.current = p;
          }}
          onDistanceUpdate={setCenterDistance}
          settingTarget={settingTarget}
          onSettingTargetChange={setSettingTarget}
          mapStyle={mapStyle}
          hideInternalHud
        />
      ) : (
        <div style={{ padding: 24, color: "#eef2ef" }}>Loading course…</div>
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

const leftCapsuleStyle: React.CSSProperties = {
  position: "absolute",
  top: 76,
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
