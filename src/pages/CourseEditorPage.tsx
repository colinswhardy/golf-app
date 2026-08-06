import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import * as turf from "@turf/turf";
import { createTeeBox, deleteHoleFeature, getFeaturesForHole, getHolesForVersion, getLatestCourseVersion, getTeeBoxesForHole, listCourses, saveCustomHazard, updateHoleGreenPoint, updateHoleWaypoints, updateTeeBoxLocation } from "../lib/courseRepo";
import { AppBar, EmptyState, Icon, Page } from "../components/ui";
import { SATELLITE_STYLE } from "../components/CourseMap";
import { applyTouchDragOffset } from "../lib/mapTouch";
import { distanceYards } from "../lib/geo";
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
    <Page>
      <AppBar title="Course editor" subtitle="Fix mis-mapped tees, greens, waypoints and hazards" />
      {!courses ? (
        <div className="card dim small">Loading…</div>
      ) : courses.length === 0 ? (
        <EmptyState title="No courses imported yet" />
      ) : (
        <div className="stack">
          {courses.map((c) => (
            <Link key={c.id} to={`/course-editor/${c.id}`} className="list-row">
              <span className="truncate">{c.name}</span>
              <Icon.chevron size={16} />
            </Link>
          ))}
        </div>
      )}
    </Page>
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
    const green =
      holeFeatures.find((f) => f.featureType === "green" && f.geometry.type === "Polygon") ??
      holeFeatures.find((f) => f.featureType === "fairway" && f.geometry.type === "Polygon");
    return green ? centroidLatLng(green.geometry as GeoJSON.Polygon) : null;
  }, [holeFeatures, currentHole]);

  const [selectedTeeBoxId, setSelectedTeeBoxId] = useState<string | null>(null);
  const [draftLocation, setDraftLocation] = useState<LatLng | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // Manual tee-box creation: `addingTee` swaps the bottom bar over to a name field, so a new tee
  // is named before it exists rather than being created as "Tee" and renamed later (there is no
  // rename). Once placed it's an ordinary tee box — same drag + Save path as any imported one.
  const [addingTee, setAddingTee] = useState(false);
  const [newTeeName, setNewTeeName] = useState("");

  // --- Hazard drawing states ---
  const [drawingMode, setDrawingMode] = useState<"none" | "point" | "line" | "area">("none");
  const [drawingCoords, setDrawingCoords] = useState<LatLng[]>([]);

  // --- Green + waypoint editing states ---
  // draftGreen is the editable green position: null means "no override, use the polygon centroid"
  // (the marker renders at draftGreen ?? greenCentroid). greenDirty tracks an unsaved drag/place.
  const [draftGreen, setDraftGreen] = useState<LatLng | null>(null);
  const [greenDirty, setGreenDirty] = useState(false);
  // Waypoint markers are managed imperatively (like the measure dots on the round map); waypointMode
  // arms map-tap-to-add, waypointDirty flags unsaved add/drag/delete edits.
  const [waypointMode, setWaypointMode] = useState(false);
  const [waypointDirty, setWaypointDirty] = useState(false);
  const [mapReady, setMapReady] = useState(false);

  const selectedTeeBox = teeBoxes?.find((t) => t.id === selectedTeeBoxId) ?? null;
  const isDirty = !!selectedTeeBox && !!draftLocation && (draftLocation.lat !== selectedTeeBox.location.lat || draftLocation.lng !== selectedTeeBox.location.lng);

  // Default to the first tee box whenever the hole (or its tee box list) changes.
  useEffect(() => {
    setSelectedTeeBoxId(teeBoxes?.[0]?.id ?? null);
    setStatus(null);
    setDrawingMode("none");
    setDrawingCoords([]);
    setWaypointMode(false);
    setWaypointDirty(false);
    setDraftGreen(currentHole?.greenPoint ?? null);
    setGreenDirty(false);
    setAddingTee(false);
    setNewTeeName("");
  }, [currentHole?.id, teeBoxes?.length]);
  useEffect(() => {
    setDraftLocation(selectedTeeBox?.location ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTeeBoxId, selectedTeeBox?.location.lat, selectedTeeBox?.location.lng]);

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const teeMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const greenMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const waypointMarkersRef = useRef<Map<string, mapboxgl.Marker>>(new Map());
  const draftLocationRef = useRef(draftLocation);
  draftLocationRef.current = draftLocation;
  const setDraftLocationRef = useRef(setDraftLocation);
  setDraftLocationRef.current = setDraftLocation;
  const setDraftGreenRef = useRef(setDraftGreen);
  setDraftGreenRef.current = setDraftGreen;
  const setGreenDirtyRef = useRef(setGreenDirty);
  setGreenDirtyRef.current = setGreenDirty;
  const setWaypointDirtyRef = useRef(setWaypointDirty);
  setWaypointDirtyRef.current = setWaypointDirty;

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

    map.on("load", () => {
      setMapReady(true);
      // Add existing-hazards source & layers
      map.addSource("existing-hazards", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] }
      });
      map.addLayer({
        id: "existing-hazards-fill",
        type: "fill",
        source: "existing-hazards",
        paint: {
          "fill-color": "#3b82f6",
          "fill-opacity": 0.4
        }
      });
      map.addLayer({
        id: "existing-hazards-outline",
        type: "line",
        source: "existing-hazards",
        paint: {
          "line-color": "#2563eb",
          "line-width": 2
        }
      });

      // Add draw-hazard source & layers
      map.addSource("draw-hazard", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] }
      });
      map.addLayer({
        id: "draw-hazard-fill",
        type: "fill",
        source: "draw-hazard",
        filter: ["==", ["get", "type"], "area"],
        paint: {
          "fill-color": "#ef4444",
          "fill-opacity": 0.35
        }
      });
      map.addLayer({
        id: "draw-hazard-line",
        type: "line",
        source: "draw-hazard",
        filter: ["==", ["get", "type"], "line"],
        paint: {
          "line-color": "#ef4444",
          "line-width": 3,
          "line-dasharray": [2, 1]
        }
      });
      map.addLayer({
        id: "draw-hazard-circle",
        type: "circle",
        source: "draw-hazard",
        filter: ["==", ["get", "type"], "vertex"],
        paint: {
          "circle-radius": 5,
          "circle-color": "#ef4444",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5
        }
      });
    });

    return () => {
      map.remove();
      mapRef.current = null;
      teeMarkerRef.current = null;
      greenMarkerRef.current = null;
      waypointMarkersRef.current.clear();
      setMapReady(false);
    };
  }, []);

  // --- Render existing hazards ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const source = map.getSource("existing-hazards") as mapboxgl.GeoJSONSource | undefined;
    if (!source) return;

    const hazards = holeFeatures?.filter((f) => f.featureType === "hazard") ?? [];
    source.setData({
      type: "FeatureCollection",
      features: hazards.map((h) => ({
        type: "Feature",
        properties: {},
        geometry: h.geometry
      }))
    });
  }, [holeFeatures]);

  // --- Render draw preview ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const source = map.getSource("draw-hazard") as mapboxgl.GeoJSONSource | undefined;
    if (!source) return;

    if (drawingCoords.length === 0) {
      source.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    const features: GeoJSON.Feature[] = [];

    // Add vertices
    drawingCoords.forEach((c) => {
      features.push({
        type: "Feature",
        properties: { type: "vertex" },
        geometry: { type: "Point", coordinates: [c.lng, c.lat] }
      });
    });

    // Add line or polygon preview
    if (drawingMode === "line" && drawingCoords.length > 1) {
      features.push({
        type: "Feature",
        properties: { type: "line" },
        geometry: { type: "LineString", coordinates: drawingCoords.map((c) => [c.lng, c.lat]) }
      });
    } else if (drawingMode === "area" && drawingCoords.length > 1) {
      if (drawingCoords.length >= 3) {
        features.push({
          type: "Feature",
          properties: { type: "area" },
          geometry: { type: "Polygon", coordinates: [[...drawingCoords, drawingCoords[0]].map((c) => [c.lng, c.lat])] }
        });
      } else {
        features.push({
          type: "Feature",
          properties: { type: "line" },
          geometry: { type: "LineString", coordinates: drawingCoords.map((c) => [c.lng, c.lat]) }
        });
      }
    }

    source.setData({
      type: "FeatureCollection",
      features
    });
  }, [drawingCoords, drawingMode]);

  // --- Handle Map Drawing Clicks ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || drawingMode === "none") return;

    const handleDrawingClick = (e: mapboxgl.MapMouseEvent) => {
      const clicked = { lat: e.lngLat.lat, lng: e.lngLat.lng };

      if (drawingMode === "point") {
        const pt = turf.point([clicked.lng, clicked.lat]);
        const buffered = turf.buffer(pt, 3, { units: "meters" });
        if (buffered && currentHole) {
          const poly = buffered.geometry as GeoJSON.Polygon;
          saveCustomHazard(currentHole.id, poly).then(() => {
            setDrawingMode("none");
            setDrawingCoords([]);
            setStatus("Saved custom point hazard.");
          });
        }
      } else {
        setDrawingCoords((prev) => [...prev, clicked]);
      }
    };

    map.on("click", handleDrawingClick);
    map.getCanvas().style.cursor = "crosshair";

    return () => {
      map.off("click", handleDrawingClick);
      map.getCanvas().style.cursor = "";
    };
  }, [drawingMode, currentHole]);

  // --- Draggable green marker: renders at the editor override (draftGreen) if set, else the
  // polygon centroid. Dragging it stages a green-location override (saved via "Save green"), which
  // the round map then uses as the aim target — including for holes that have no green polygon. ---
  const greenPos = draftGreen ?? greenCentroid;
  // Live tee→green yardage for the bottom bar. Keyed off draftLocation rather than the persisted
  // tee position so it tracks the marker mid-drag (the drag handler updates draftLocation on every
  // tick), which is what makes it usable for judging whether a hand-placed tee is in the right
  // spot. Null when the hole has no green at all — those holes exist, so the readout must not
  // silently render a distance to nothing.
  const teeToGreenYards = useMemo(
    () => (draftLocation && greenPos ? Math.round(distanceYards(draftLocation, greenPos)) : null),
    [draftLocation?.lat, draftLocation?.lng, greenPos?.lat, greenPos?.lng]
  );
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !greenPos) {
      greenMarkerRef.current?.remove();
      greenMarkerRef.current = null;
      return;
    }
    if (!greenMarkerRef.current) {
      const el = document.createElement("div");
      el.className = "map-touch-target";
      el.style.cssText = "width:44px;height:44px;display:flex;align-items:center;justify-content:center;";
      const dot = document.createElement("div");
      dot.className = "map-touch-dot";
      dot.style.cssText =
        "width:16px;height:16px;border-radius:50%;background:#e63946;border:3px solid #fff;box-shadow:0 0 4px rgba(0,0,0,.5);cursor:grab;transition:transform .1s,background .1s,border-color .1s;";
      el.appendChild(dot);
      const marker = new mapboxgl.Marker({ element: el, draggable: true, anchor: "center" })
        .setLngLat([greenPos.lng, greenPos.lat])
        .addTo(map);
      marker.on("drag", () => {
        const p = applyTouchDragOffset(map, marker);
        setDraftGreenRef.current(p);
        setGreenDirtyRef.current(true);
      });
      marker.on("dragend", () => {
        const pos = marker.getLngLat();
        setDraftGreenRef.current({ lat: pos.lat, lng: pos.lng });
        setGreenDirtyRef.current(true);
      });
      greenMarkerRef.current = marker;
    } else {
      greenMarkerRef.current.setLngLat([greenPos.lng, greenPos.lat]);
    }
  }, [greenPos?.lat, greenPos?.lng]);

  // Creates one draggable waypoint marker (double-click to delete). Imperative, like the round
  // map's measure dots — positions are read back off the markers on save.
  function addWaypointMarker(point: LatLng) {
    const map = mapRef.current;
    if (!map) return;
    const id = crypto.randomUUID();
    const el = document.createElement("div");
    el.className = "map-touch-target";
    el.style.cssText = "width:44px;height:44px;display:flex;align-items:center;justify-content:center;";
    const dot = document.createElement("div");
    dot.className = "map-touch-dot";
    dot.style.cssText =
      "width:16px;height:16px;border-radius:50%;background:#ffc043;border:3px solid rgba(0,0,0,.6);box-shadow:0 0 4px rgba(0,0,0,.5);cursor:grab;transition:transform .1s,background .1s,border-color .1s;";
    el.appendChild(dot);
    const marker = new mapboxgl.Marker({ element: el, draggable: true, anchor: "center" })
      .setLngLat([point.lng, point.lat])
      .addTo(map);
    marker.on("drag", () => {
      applyTouchDragOffset(map, marker);
      setWaypointDirtyRef.current(true);
    });
    marker.on("dragend", () => setWaypointDirtyRef.current(true));
    el.addEventListener("dblclick", (evt) => {
      evt.stopPropagation();
      marker.remove();
      waypointMarkersRef.current.delete(id);
      setWaypointDirtyRef.current(true);
    });
    waypointMarkersRef.current.set(id, marker);
  }

  // Rebuilds the waypoint markers from the hole's saved waypoints whenever the hole changes (or the
  // map first becomes ready). Runs only when not mid-edit so it never wipes unsaved additions.
  useEffect(() => {
    if (!mapReady || !currentHole) return;
    waypointMarkersRef.current.forEach((m) => m.remove());
    waypointMarkersRef.current.clear();
    for (const wp of currentHole.waypoints ?? []) addWaypointMarker(wp);
    setWaypointDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentHole?.id, mapReady]);

  // --- Waypoint add-on-tap (only while waypoint mode is armed) ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !waypointMode) return;
    const onClick = (e: mapboxgl.MapMouseEvent) => {
      addWaypointMarker({ lat: e.lngLat.lat, lng: e.lngLat.lng });
      setWaypointDirty(true);
    };
    map.on("click", onClick);
    map.getCanvas().style.cursor = "crosshair";
    return () => {
      map.off("click", onClick);
      map.getCanvas().style.cursor = "";
    };
  }, [waypointMode]);

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
        "width:16px;height:16px;border-radius:50%;background:#ffffff;border:3px solid rgba(0,0,0,.55);box-shadow:0 0 4px rgba(0,0,0,.5);cursor:grab;transition:transform .1s,background .1s,border-color .1s;";
      el.appendChild(dot);

      const marker = new mapboxgl.Marker({ element: el, draggable: true, anchor: "center" })
        .setLngLat([draftLocation.lng, draftLocation.lat])
        .addTo(map);
      marker.on("drag", () => {
        setDraftLocationRef.current(applyTouchDragOffset(map, marker));
      });
      marker.on("dragend", () => {
        const pos = marker.getLngLat();
        setDraftLocationRef.current({ lat: pos.lat, lng: pos.lng });
      });
      teeMarkerRef.current = marker;
    } else {
      teeMarkerRef.current.setLngLat([draftLocation.lng, draftLocation.lat]);
    }
  }, [draftLocation]);

  // Recenters the camera once per hole/tee-box selection (not on every drag tick, or the map
  // would fight the marker being dragged). Falls back to the green when a hole has no tee box yet
  // (otherwise the editor would leave you stranded on the wrong part of the course for exactly the
  // holes you most need to fix — the ones missing a tee).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const center = selectedTeeBox?.location ?? greenPos ?? null;
    if (!center) return;
    map.easeTo({ center: [center.lng, center.lat], zoom: 18, duration: 400 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTeeBox?.id, currentHole?.id, mapReady]);

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

  // Creates a tee box at the current map centre under a name typed by hand. Two cases it serves:
  // a hole the import left with no tee at all (unplayable on the round map without one), and
  // adding the real tee sets to a course whose OSM `golf=tee` polygons carry no `teebox` colour
  // tag — Legends of the Niagara has none on any of its 175 tees, so every tee there imports as a
  // generic "Tee". Dropping at the map centre (not the green, not the hole's first vertex) keeps
  // it in view for the drag that follows; the tee is selected immediately so the distance-to-green
  // readout is live while positioning it.
  async function handleAddTeeBox() {
    const map = mapRef.current;
    if (!map || !currentHole) return;
    const name = newTeeName.trim();
    if (!name) return;
    const c = map.getCenter();
    const tee = await createTeeBox(currentHole.id, name, { lat: c.lat, lng: c.lng });
    setSelectedTeeBoxId(tee.id);
    setAddingTee(false);
    setNewTeeName("");
    setStatus(`Added "${name}" — drag it onto the tee, then Save.`);
  }

  async function handleSaveGreen() {
    if (!currentHole || !draftGreen) return;
    await updateHoleGreenPoint(currentHole.id, draftGreen);
    setGreenDirty(false);
    setStatus("Saved green location.");
  }

  async function handleResetGreen() {
    if (!currentHole) return;
    await updateHoleGreenPoint(currentHole.id, null);
    setDraftGreen(null);
    setGreenDirty(false);
    setStatus("Cleared green override (back to mapped green).");
  }

  async function handleSaveWaypoints() {
    if (!currentHole) return;
    const points = Array.from(waypointMarkersRef.current.values()).map((m) => {
      const p = m.getLngLat();
      return { lat: p.lat, lng: p.lng };
    });
    await updateHoleWaypoints(currentHole.id, points);
    setWaypointDirty(false);
    setWaypointMode(false);
    setStatus(points.length ? `Saved ${points.length} waypoint${points.length === 1 ? "" : "s"}.` : "Cleared waypoints.");
  }

  async function handleFinishDrawing() {
    if (!currentHole || drawingCoords.length === 0) return;
    try {
      let geometry: GeoJSON.Polygon | null = null;
      if (drawingMode === "line") {
        if (drawingCoords.length < 2) return;
        const line = turf.lineString(drawingCoords.map((c) => [c.lng, c.lat]));
        const buffered = turf.buffer(line, 1.5, { units: "meters" });
        if (!buffered) return;
        geometry = buffered.geometry as GeoJSON.Polygon;
      } else if (drawingMode === "area") {
        if (drawingCoords.length < 3) return;
        const ring = [...drawingCoords, drawingCoords[0]].map((c) => [c.lng, c.lat]);
        geometry = turf.polygon([ring]).geometry as GeoJSON.Polygon;
      }

      if (geometry) {
        await saveCustomHazard(currentHole.id, geometry);
        setStatus(`Saved custom ${drawingMode} hazard.`);
      }
    } catch (err) {
      console.error(err);
      setStatus("Error saving hazard geometry.");
    } finally {
      setDrawingMode("none");
      setDrawingCoords([]);
    }
  }

  async function handleDeleteHazard(featureId: string) {
    try {
      await deleteHoleFeature(featureId);
      setStatus("Deleted hazard feature.");
    } catch (err) {
      console.error(err);
      setStatus("Error deleting hazard.");
    }
  }

  if (!TOKEN) {
    return (
      <div style={{ padding: 24 }}>
        No Mapbox token configured. Add <code>VITE_MAPBOX_TOKEN</code> to <code>.env.local</code>.
      </div>
    );
  }

  const holeHazards = holeFeatures?.filter((f) => f.featureType === "hazard") ?? [];

  return (
    <div className="map-root">
      <button
        className="map-btn glass"
        onClick={() => navigate("/course-editor")}
        style={{ position: "absolute", top: "calc(12px + var(--safe-t))", left: 12, zIndex: 5 }}
        aria-label="Back to course list"
      >
        <Icon.back size={19} />
      </button>

      {currentHole && (
        <div className="hole-bar glass">
          <button className="hole-bar__nav" onClick={() => setHoleNumber((n) => Math.max(1, n - 1))} disabled={holeNumber <= 1}>
            ‹
          </button>
          <span className="hole-bar__label">
            {currentHole.number}
            <span className="hole-bar__par">
              {" · "}Par {currentHole.par}
            </span>
          </span>
          <button
            className="hole-bar__nav"
            onClick={() => setHoleNumber((n) => Math.min(maxHoleNumber, n + 1))}
            disabled={holeNumber >= maxHoleNumber}
          >
            ›
          </button>
        </div>
      )}

      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

      {teeBoxes && teeBoxes.length > 0 && (
        <div style={{ position: "absolute", top: "calc(66px + var(--safe-t))", left: 12, zIndex: 4, display: "flex", flexDirection: "column", gap: 6 }}>
          {teeBoxes.map((t: TeeBox) => (
            <button
              key={t.id}
              className={`chip chip--sm glass${t.id === selectedTeeBoxId ? " chip--active" : ""}`}
              onClick={() => setSelectedTeeBoxId(t.id)}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}

      {teeBoxes && teeBoxes.length === 0 && (
        <div
          className="glass"
          style={{
            position: "absolute",
            bottom: 92,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 4,
            borderRadius: 12,
            padding: "10px 14px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            whiteSpace: "nowrap"
          }}
        >
          <span className="small danger">No tee boxes on this hole.</span>
          <button className="btn btn--sm" onClick={() => setAddingTee(true)}>
            Add a tee box
          </button>
        </div>
      )}

      {/* Hazard panel */}
      {currentHole && (
        <div className="popover glass" style={{ top: "calc(66px + var(--safe-t))", right: 12, width: 196, maxHeight: "56vh", overflowY: "auto" }}>
          <div className="section__title mb-2">Hazards</div>

          {drawingMode === "none" ? (
            <>
              <div className="chip-row mb-2">
                <button className="chip chip--sm" onClick={() => setDrawingMode("point")}>
                  Point
                </button>
                <button className="chip chip--sm" onClick={() => setDrawingMode("line")}>
                  Line
                </button>
                <button className="chip chip--sm" onClick={() => setDrawingMode("area")}>
                  Area
                </button>
              </div>
              <div className="stack" style={{ gap: 5 }}>
                {holeHazards.length === 0 ? (
                  <div className="tiny faint">No custom hazards</div>
                ) : (
                  holeHazards.map((h, i) => (
                    <div key={h.id} className="row row--between" style={{ fontSize: 12 }}>
                      <span className="dim">Hazard {i + 1}</span>
                      <button
                        className="map-btn"
                        style={{ width: 26, height: 26, color: "var(--danger)" }}
                        onClick={() => handleDeleteHazard(h.id)}
                        aria-label="Delete hazard"
                      >
                        <Icon.trash size={14} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              <div className="tiny warn bold">Drawing {drawingMode}</div>
              <div className="tiny dim">
                {drawingMode === "point" && "Tap the map once — saves as a small 3m circle."}
                {drawingMode === "line" && `Tap to add points (${drawingCoords.length}), then Finish.`}
                {drawingMode === "area" && `Tap to add vertices (${drawingCoords.length}), then Finish.`}
              </div>
              <div className="row" style={{ gap: 6 }}>
                {drawingMode !== "point" && (
                  <button
                    className="btn btn--sm btn--primary"
                    onClick={handleFinishDrawing}
                    disabled={(drawingMode === "line" && drawingCoords.length < 2) || (drawingMode === "area" && drawingCoords.length < 3)}
                  >
                    Finish
                  </button>
                )}
                <button
                  className="btn btn--sm btn--ghost"
                  onClick={() => {
                    setDrawingMode("none");
                    setDrawingCoords([]);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Green + waypoints panel, opposite the hazard panel */}
      {currentHole && (
        <div
          className="popover glass"
          style={{ top: "calc(66px + var(--safe-t))", left: 12, width: 190, maxHeight: "56vh", overflowY: "auto", marginTop: teeBoxes && teeBoxes.length ? 44 : 0 }}
        >
          <div className="section__title mb-2">Green &amp; waypoints</div>
          <div className="tiny dim mb-2">{greenPos ? "Drag the red dot to move the green." : "No green yet — place one."}</div>
          <div className="chip-row mb-2">
            {!greenPos && (
              <button
                className="chip chip--sm"
                onClick={() => {
                  const c = mapRef.current?.getCenter();
                  if (c) {
                    setDraftGreen({ lat: c.lat, lng: c.lng });
                    setGreenDirty(true);
                  }
                }}
              >
                Add at centre
              </button>
            )}
            <button className="btn btn--sm btn--primary" onClick={handleSaveGreen} disabled={!greenDirty}>
              Save green
            </button>
            {(currentHole.greenPoint || draftGreen) && (
              <button className="chip chip--sm" onClick={handleResetGreen}>
                Reset
              </button>
            )}
          </div>

          <div className="section__title mb-1">Waypoints ({waypointMarkersRef.current.size})</div>
          <div className="tiny dim mb-2">
            {waypointMode ? "Tap to add. Drag to move, double-tap to remove." : "Saved layup points seed dots when you play the hole."}
          </div>
          <div className="chip-row">
            <button
              className={`chip chip--sm${waypointMode ? " chip--active" : ""}`}
              onClick={() => {
                setWaypointMode((v) => !v);
                setDrawingMode("none");
              }}
            >
              {waypointMode ? "Done" : "Add"}
            </button>
            <button className="btn btn--sm btn--primary" onClick={handleSaveWaypoints} disabled={!waypointDirty}>
              Save
            </button>
          </div>
        </div>
      )}

      <div className="round-bar">
        {addingTee ? (
          <>
            <div className="grow" style={{ minWidth: 0 }}>
              <input
                className="field grow"
                style={{ padding: "7px 10px" }}
                type="text"
                autoFocus
                value={newTeeName}
                onChange={(e) => setNewTeeName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddTeeBox();
                  if (e.key === "Escape") {
                    setAddingTee(false);
                    setNewTeeName("");
                  }
                }}
                placeholder="Tee name — e.g. Blue"
                aria-label="New tee box name"
              />
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button
                className="btn btn--sm btn--ghost"
                onClick={() => {
                  setAddingTee(false);
                  setNewTeeName("");
                }}
              >
                Cancel
              </button>
              <button className="btn btn--sm btn--primary" onClick={handleAddTeeBox} disabled={!newTeeName.trim()}>
                Place
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="small dim truncate">
                {selectedTeeBox ? (
                  <>
                    {`Dragging "${selectedTeeBox.name}" — `}
                    {teeToGreenYards === null ? (
                      "no green on this hole"
                    ) : (
                      <span className="accent bold">{teeToGreenYards} yds to green</span>
                    )}
                  </>
                ) : (
                  "Edit the green, waypoints or hazards"
                )}
              </div>
              {status && <div className="tiny accent mt-1">{status}</div>}
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn--sm btn--ghost" onClick={() => setAddingTee(true)} disabled={!currentHole}>
                + Tee
              </button>
              <button className="btn btn--sm btn--ghost" onClick={handleClear} disabled={!isDirty}>
                Clear
              </button>
              <button className="btn btn--sm btn--primary" onClick={handleSave} disabled={!isDirty}>
                Save
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

