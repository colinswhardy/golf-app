import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import * as turf from "@turf/turf";
import { getFeaturesForHole, getHolesForVersion, getLatestCourseVersion, getTeeBoxesForHole, listCourses, updateTeeBoxLocation } from "../lib/courseRepo";
import { PageHeader } from "../components/PageHeader";
import { SATELLITE_STYLE } from "../components/CourseMap";
import type { LatLng, TeeBox } from "../types/domain";

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

function centroidLatLng(geom: GeoJSON.Polygon): LatLng {
  const [lng, lat] = turf.centroid(turf.feature(geom)).geometry.coordinates;
  return { lat, lng };
}

/**
 * In-app tool for correcting mis-mapped tee box coordinates by hand, without needing to round-trip
 * through OpenStreetMap + Overpass Turbo + a re-import. Course list -> hole-by-hole workspace ->
 * drag a tee box's marker on the map, Save to persist, or Clear to discard the unsaved drag.
 * Deliberately a standalone map (not CourseMap) — same rationale as ReviewMap (DESIGN.md §11):
 * this has none of CourseMap's live-round machinery (GPS blue dot, measuring tool, dispersion,
 * bunker cards), so reusing it would mostly mean threading through props to hide all of that.
 */
export function CourseEditorPage() {
  const { courseId } = useParams();
  return courseId ? <CourseEditorWorkspace courseId={courseId} /> : <CourseEditorCourseList />;
}

function CourseEditorCourseList() {
  const courses = useLiveQuery(() => listCourses(), []);

  return (
    <div style={{ padding: "16px 20px", maxWidth: 600, margin: "0 auto" }}>
      <PageHeader title="Course Editor" />
      <p style={{ opacity: 0.75, fontSize: 13, marginBottom: 16 }}>
        Pick a course to correct mis-mapped tee box coordinates by hand.
      </p>
      {!courses && <p style={{ opacity: 0.5 }}>Loading…</p>}
      {courses && courses.length === 0 && <p style={{ opacity: 0.5 }}>No courses imported yet.</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {courses?.map((c) => (
          <Link key={c.id} to={`/course-editor/${c.id}`} style={courseRowStyle}>
            {c.name}
          </Link>
        ))}
      </div>
    </div>
  );
}

function CourseEditorWorkspace({ courseId }: { courseId: string }) {
  const navigate = useNavigate();
  const courseVersion = useLiveQuery(() => getLatestCourseVersion(courseId), [courseId]);
  const holes = useLiveQuery(() => (courseVersion ? getHolesForVersion(courseVersion.id) : []), [courseVersion?.id]);

  const [holeNumber, setHoleNumber] = useState(1);
  const currentHole = useMemo(() => holes?.find((h) => h.number === holeNumber), [holes, holeNumber]);
  const maxHoleNumber = holes?.length ? Math.max(...holes.map((h) => h.number)) : 1;

  const teeBoxes = useLiveQuery(() => (currentHole ? getTeeBoxesForHole(currentHole.id) : []), [currentHole?.id]);
  const holeFeatures = useLiveQuery(() => (currentHole ? getFeaturesForHole(currentHole.id) : []), [currentHole?.id]);
  const greenCentroid = useMemo(() => {
    if (!holeFeatures?.length || !currentHole || !holeFeatures.every((f) => f.holeId === currentHole.id)) return null;
    const green = holeFeatures.find((f) => f.featureType === "green") ?? holeFeatures.find((f) => f.featureType === "fairway");
    return green ? centroidLatLng(green.geometry) : null;
  }, [holeFeatures, currentHole]);

  const [selectedTeeBoxId, setSelectedTeeBoxId] = useState<string | null>(null);
  const [draftLocation, setDraftLocation] = useState<LatLng | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const selectedTeeBox = teeBoxes?.find((t) => t.id === selectedTeeBoxId) ?? null;
  const isDirty = !!selectedTeeBox && !!draftLocation && (draftLocation.lat !== selectedTeeBox.location.lat || draftLocation.lng !== selectedTeeBox.location.lng);

  // Default to the first tee box whenever the hole (or its tee box list) changes.
  useEffect(() => {
    setSelectedTeeBoxId(teeBoxes?.[0]?.id ?? null);
    setStatus(null);
  }, [currentHole?.id, teeBoxes?.length]);
  useEffect(() => {
    setDraftLocation(selectedTeeBox?.location ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTeeBoxId, selectedTeeBox?.location.lat, selectedTeeBox?.location.lng]);

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const teeMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const greenMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const draftLocationRef = useRef(draftLocation);
  draftLocationRef.current = draftLocation;
  const setDraftLocationRef = useRef(setDraftLocation);
  setDraftLocationRef.current = setDraftLocation;

  // --- Map init: one map per courseId (not per hole — just recentres/repositions markers as
  // the hole/selection changes, avoiding a full teardown+rebuild on every hole navigation). ---
  useEffect(() => {
    if (!TOKEN || !containerRef.current || mapRef.current) return;
    mapboxgl.accessToken = TOKEN;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: SATELLITE_STYLE,
      center: [-80.2, 43.55],
      zoom: 16
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      teeMarkerRef.current = null;
      greenMarkerRef.current = null;
    };
  }, []);

  // --- Green reference marker (read-only) ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !greenCentroid) {
      greenMarkerRef.current?.remove();
      greenMarkerRef.current = null;
      return;
    }
    if (!greenMarkerRef.current) {
      const el = document.createElement("div");
      el.style.cssText =
        "width:14px;height:14px;border-radius:50%;background:#e63946;border:2px solid #fff;box-shadow:0 0 4px rgba(0,0,0,.5);";
      greenMarkerRef.current = new mapboxgl.Marker({ element: el, anchor: "center" })
        .setLngLat([greenCentroid.lng, greenCentroid.lat])
        .addTo(map);
    } else {
      greenMarkerRef.current.setLngLat([greenCentroid.lng, greenCentroid.lat]);
    }
  }, [greenCentroid]);

  // --- Draggable tee marker for the selected tee box; recenters the camera on hole/selection change ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !draftLocation) {
      teeMarkerRef.current?.remove();
      teeMarkerRef.current = null;
      return;
    }

    if (!teeMarkerRef.current) {
      const el = document.createElement("div");
      el.className = "map-touch-target";
      el.style.cssText = "width:44px;height:44px;display:flex;align-items:center;justify-content:center;";
      const dot = document.createElement("div");
      dot.className = "map-touch-dot";
      dot.style.cssText =
        "width:16px;height:16px;border-radius:50%;background:#ffffff;border:3px solid #2f5c3d;box-shadow:0 0 4px rgba(0,0,0,.5);cursor:grab;transition:transform .1s,background .1s,border-color .1s;";
      el.appendChild(dot);

      const marker = new mapboxgl.Marker({ element: el, draggable: true, anchor: "center" })
        .setLngLat([draftLocation.lng, draftLocation.lat])
        .addTo(map);
      marker.on("drag", () => {
        const pos = marker.getLngLat();
        setDraftLocationRef.current({ lat: pos.lat, lng: pos.lng });
      });
      teeMarkerRef.current = marker;
    } else {
      teeMarkerRef.current.setLngLat([draftLocation.lng, draftLocation.lat]);
    }
  }, [draftLocation]);

  // Recenters the camera once per hole/tee-box selection (not on every drag tick, or the map
  // would fight the marker being dragged).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedTeeBox) return;
    map.easeTo({ center: [selectedTeeBox.location.lng, selectedTeeBox.location.lat], zoom: 18, duration: 400 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTeeBox?.id]);

  async function handleSave() {
    if (!selectedTeeBox || !draftLocation) return;
    await updateTeeBoxLocation(selectedTeeBox.id, draftLocation);
    setStatus(`Saved "${selectedTeeBox.name}".`);
  }

  function handleClear() {
    if (!selectedTeeBox) return;
    setDraftLocation(selectedTeeBox.location);
    setStatus(null);
  }

  if (!TOKEN) {
    return (
      <div style={{ padding: 24 }}>
        No Mapbox token configured. Add <code>VITE_MAPBOX_TOKEN</code> to <code>.env.local</code>.
      </div>
    );
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <button onClick={() => navigate("/course-editor")} style={backButtonStyle} aria-label="Back to course list">
        ←
      </button>

      {currentHole && (
        <div style={holeHeaderStyle}>
          <button onClick={() => setHoleNumber((n) => Math.max(1, n - 1))} disabled={holeNumber <= 1} style={navButtonStyle}>
            ‹
          </button>
          <span>
            Hole {currentHole.number} · Par {currentHole.par}
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

      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

      {teeBoxes && teeBoxes.length > 0 && (
        <div style={teeChipRowStyle}>
          {teeBoxes.map((t: TeeBox) => (
            <button
              key={t.id}
              onClick={() => setSelectedTeeBoxId(t.id)}
              style={{ ...teeChipStyle, ...(t.id === selectedTeeBoxId ? teeChipActiveStyle : {}) }}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}

      {teeBoxes && teeBoxes.length === 0 && <div style={emptyBannerStyle}>No tee boxes mapped for this hole.</div>}

      <div style={bottomPanelStyle}>
        <div style={{ fontSize: 12, opacity: 0.75 }}>
          {selectedTeeBox ? `Dragging "${selectedTeeBox.name}" — red dot is the green for reference.` : "Select a tee to edit."}
          {status && <div style={{ color: "#10b981", marginTop: 4 }}>{status}</div>}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={handleClear} disabled={!isDirty} style={{ ...editorButtonStyle, opacity: isDirty ? 1 : 0.5 }}>
            Clear
          </button>
          <button onClick={handleSave} disabled={!isDirty} style={{ ...primaryEditorButtonStyle, opacity: isDirty ? 1 : 0.5 }}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

const courseRowStyle: React.CSSProperties = {
  display: "block",
  padding: "12px 16px",
  background: "#111813",
  border: "1px solid #1c2c20",
  borderRadius: 12,
  color: "#eef2ef",
  textDecoration: "none",
  fontSize: 14
};

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
  border: "none",
  cursor: "pointer",
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
  background: "#000000",
  border: "1px solid #16a34a",
  color: "#eef2ef",
  padding: "7px 16px",
  borderRadius: 999,
  fontSize: 13,
  fontWeight: 600,
  whiteSpace: "nowrap"
};

const navButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#eef2ef",
  fontSize: 22,
  padding: "0 6px",
  cursor: "pointer"
};

const teeChipRowStyle: React.CSSProperties = {
  position: "absolute",
  top: 76,
  left: 12,
  zIndex: 2,
  display: "flex",
  flexDirection: "column",
  gap: 6
};

const teeChipStyle: React.CSSProperties = {
  padding: "6px 12px",
  background: "rgba(11,15,12,0.85)",
  color: "#eef2ef",
  border: "1px solid #2f5c3d",
  borderRadius: 999,
  fontSize: 12,
  cursor: "pointer",
  whiteSpace: "nowrap"
};

const teeChipActiveStyle: React.CSSProperties = {
  background: "#f5d90a",
  color: "#111",
  border: "1px solid #f5d90a"
};

const emptyBannerStyle: React.CSSProperties = {
  position: "absolute",
  top: 76,
  left: 12,
  zIndex: 2,
  background: "rgba(11,15,12,0.85)",
  color: "#fca5a5",
  padding: "8px 12px",
  borderRadius: 8,
  fontSize: 12
};

const bottomPanelStyle: React.CSSProperties = {
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
  padding: "12px 16px",
  color: "#eef2ef"
};

const editorButtonStyle: React.CSSProperties = {
  padding: "10px 16px",
  background: "#1a3a24",
  color: "#eef2ef",
  border: "1px solid #2f5c3d",
  borderRadius: 999,
  fontSize: 14,
  cursor: "pointer"
};

const primaryEditorButtonStyle: React.CSSProperties = {
  padding: "10px 16px",
  background: "#f5d90a",
  color: "#111",
  border: "none",
  borderRadius: 999,
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer"
};
