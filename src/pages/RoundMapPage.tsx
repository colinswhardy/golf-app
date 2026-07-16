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
import { CourseMap } from "../components/CourseMap";
import { HoleScoreSheet, ShotSheet } from "../components/RoundSheets";
import { distanceMeters } from "../lib/geo";
import type { Club, LatLng, Round } from "../types/domain";

const FAR_FROM_HOLE_METERS = 300;

function centroidLatLng(geom: GeoJSON.Polygon): LatLng {
  const [lng, lat] = turf.centroid(turf.feature(geom)).geometry.coordinates;
  return { lat, lng };
}

export function RoundMapPage() {
  const { courseId } = useParams();
  const isDemo = courseId === "demo" || !courseId;

  const course = useLiveQuery(() => (isDemo ? undefined : db.courses.get(courseId!)), [courseId]);
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
  const [openSheet, setOpenSheet] = useState<"shot" | "score" | null>(null);
  const lastPositionRef = useRef<LatLng | null>(null);

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

  async function handleSaveShot(clubId: string | null, lie: Parameters<typeof recordShot>[0]["lie"]) {
    if (!roundHoleId || !lastPositionRef.current) return;
    await recordShot({ roundHoleId, clubId, point: lastPositionRef.current, lie });
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

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <Link to="/courses" style={closeButtonStyle}>
        ✕
      </Link>

      {!isDemo && currentHole && (
        <div style={holeHeaderStyle}>
          <button onClick={() => setHoleNumber((n) => Math.max(1, n - 1))} disabled={holeNumber <= 1} style={navButtonStyle}>
            ‹
          </button>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 15 }}>
              Hole {currentHole.number} · Par {currentHole.par}
              {currentHole.defaultYardage ? ` · ${currentHole.defaultYardage}y` : ""}
            </div>
            {course && <div style={{ fontSize: 11, opacity: 0.7 }}>{course.name}</div>}
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

      {isDemo ? (
        <CourseMap />
      ) : currentHole ? (
        <CourseMap
          key={currentHole.id}
          initialTarget={greenCentroid}
          fallbackOrigin={fallbackOrigin}
          onPositionChange={(p) => {
            lastPositionRef.current = p;
          }}
        />
      ) : (
        <div style={{ padding: 24, color: "#eef2ef" }}>Loading course…</div>
      )}

      {/* --- Round controls --- */}
      {!isDemo && currentHole && (
        <div style={roundBarStyle}>
          {!round ? (
            <button onClick={handleStartRound} style={roundButtonStyle}>
              ⛳ Start round
            </button>
          ) : (
            <>
              <button
                onClick={() => setOpenSheet("shot")}
                disabled={!lastPositionRef.current || !roundHoleId}
                style={{ ...roundButtonStyle, opacity: lastPositionRef.current && roundHoleId ? 1 : 0.5 }}
              >
                ⌗ Shot {shotCount + 1}
              </button>
              <button onClick={() => setOpenSheet("score")} disabled={!roundHoleId} style={roundButtonStyle}>
                🏁 Hole out
              </button>
            </>
          )}
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
    </div>
  );
}

const closeButtonStyle: React.CSSProperties = {
  position: "absolute",
  top: 12,
  right: 12,
  zIndex: 2,
  background: "rgba(11,15,12,0.75)",
  color: "#eef2ef",
  padding: "6px 10px",
  borderRadius: 8,
  textDecoration: "none"
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
  padding: "6px 12px",
  borderRadius: 8
};

const navButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#eef2ef",
  fontSize: 22,
  padding: "0 6px",
  cursor: "pointer"
};

const roundBarStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 16,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 2,
  display: "flex",
  gap: 10
};

const roundButtonStyle: React.CSSProperties = {
  padding: "12px 18px",
  background: "rgba(11,15,12,0.85)",
  color: "#eef2ef",
  border: "1px solid #2f5c3d",
  borderRadius: 999,
  fontSize: 15,
  cursor: "pointer"
};
