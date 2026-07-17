import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { bearingDegrees } from "../lib/geo";
import type { LatLng, Shot } from "../types/domain";

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const PATH_SOURCE_ID = "review-path";

interface ReviewMapProps {
  /** Shots for the hole being reviewed, sorted by shotNumber. */
  shots: Shot[];
  /** Tee box, used as a camera fallback when there are no shots recorded yet for this hole. */
  fallbackOrigin: LatLng | null;
  /** Shot id currently accepting an aim-point tap, or null if none armed. */
  armedShotId: string | null;
  /** Fires with the tapped coordinate while a shot is armed. */
  onMapClick: (point: LatLng) => void;
}

/**
 * Read-mostly map for post-round review: renders a completed hole's actual shot path
 * (numbered dots at each shot's start, solid line through them) instead of a live
 * tee->target line, and has no GPS/blue-dot/measuring-tool concepts — none of that makes
 * sense when looking at historical data, possibly from a course you're not standing on.
 * Deliberately a separate component from CourseMap rather than another pile of optional
 * props on it — the interaction model here is fundamentally different (fixed data, tap to
 * set a planned aim point) from CourseMap's live-round GPS-driven one.
 */
export function ReviewMap({ shots, fallbackOrigin, armedShotId, onMapClick }: ReviewMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const shotMarkersRef = useRef<mapboxgl.Marker[]>([]);
  const aimMarkersRef = useRef<mapboxgl.Marker[]>([]);

  const stateRef = useRef({ shots, armedShotId, onMapClick });
  stateRef.current = { shots, armedShotId, onMapClick };

  const pathPoints: LatLng[] = [];
  if (shots.length) {
    pathPoints.push(shots[0].startPoint);
    for (const s of shots) {
      if (s.endPoint) pathPoints.push(s.endPoint);
    }
  }
  const origin = pathPoints[0] ?? fallbackOrigin ?? null;
  const finalPoint = pathPoints[pathPoints.length - 1] ?? null;

  // Clears and rebuilds every marker + the path line from the current shots list. Always a
  // full rebuild rather than an incremental per-marker update — simpler, and (unlike
  // CourseMap's marker effects) inherently immune to React StrictMode's dev-only
  // mount->cleanup->mount-again cycle leaving stale refs pointing at orphaned markers, since
  // every call starts by clearing whatever it's currently tracking before recreating.
  function renderShots() {
    const map = mapRef.current;
    if (!map) return;
    const { shots: curShots, armedShotId: curArmed } = stateRef.current;

    shotMarkersRef.current.forEach((m) => m.remove());
    shotMarkersRef.current = [];
    aimMarkersRef.current.forEach((m) => m.remove());
    aimMarkersRef.current = [];

    const coordinates: [number, number][] = [];
    curShots.forEach((s, i) => {
      coordinates.push([s.startPoint.lng, s.startPoint.lat]);

      const el = document.createElement("div");
      const isArmed = s.id === curArmed;
      el.style.cssText = `width:24px;height:24px;border-radius:50%;background:${isArmed ? "#f5d90a" : "#ffffff"};border:2px solid #222;box-shadow:0 0 4px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#111;`;
      el.textContent = String(i + 1);
      shotMarkersRef.current.push(
        new mapboxgl.Marker({ element: el, anchor: "center" }).setLngLat([s.startPoint.lng, s.startPoint.lat]).addTo(map)
      );

      if (s.aimPointOverride) {
        const aimEl = document.createElement("div");
        aimEl.style.cssText = "width:16px;height:16px;border-radius:50%;background:#e63946;border:2px solid #fff;";
        aimMarkersRef.current.push(
          new mapboxgl.Marker({ element: aimEl, anchor: "center" })
            .setLngLat([s.aimPointOverride.lng, s.aimPointOverride.lat])
            .addTo(map)
        );
      }

      if (i === curShots.length - 1 && s.endPoint) {
        coordinates.push([s.endPoint.lng, s.endPoint.lat]);
      }
    });

    const source = map.getSource(PATH_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
    source?.setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } });
  }

  // --- Map init ---
  useEffect(() => {
    if (!TOKEN || !containerRef.current || mapRef.current) return;
    mapboxgl.accessToken = TOKEN;

    const center = origin ?? { lat: 43.55, lng: -80.2 };
    const bearing = origin && finalPoint ? bearingDegrees(origin, finalPoint) : 0;
    const pitch = origin && finalPoint ? 55 : 0;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center: [center.lng, center.lat],
      zoom: 17,
      pitch,
      bearing
    });
    mapRef.current = map;

    map.on("load", () => {
      map.addSource(PATH_SOURCE_ID, {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } }
      });
      map.addLayer({
        id: PATH_SOURCE_ID,
        type: "line",
        source: PATH_SOURCE_ID,
        paint: { "line-color": "#f5d90a", "line-width": 3 }
      });
      renderShots();
    });

    map.on("click", (e) => {
      const { armedShotId: curArmed, onMapClick: curOnClick } = stateRef.current;
      if (!curArmed) return;
      curOnClick({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });

    return () => {
      map.remove();
      mapRef.current = null;
      shotMarkersRef.current = [];
      aimMarkersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-centers the camera whenever real origin/finalPoint data becomes available or changes.
  // Needed because `shots`/`fallbackOrigin` come from async useLiveQuery chains in the parent
  // that are almost never resolved yet on ReviewMap's very first render — the mount effect
  // above would otherwise permanently lock the camera onto its generic fallback coordinates,
  // since it only runs once. First real placement jumps instantly (no disorienting spin from
  // the fallback location); later changes (switching holes, shots finishing loading) ease.
  const hasPlacedCameraRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !origin) return;
    const bearing = finalPoint ? bearingDegrees(origin, finalPoint) : 0;
    const pitch = finalPoint ? 55 : 0;
    if (!hasPlacedCameraRef.current) {
      map.jumpTo({ center: [origin.lng, origin.lat], bearing, pitch });
      hasPlacedCameraRef.current = true;
    } else {
      map.easeTo({ center: [origin.lng, origin.lat], bearing, pitch, duration: 600 });
    }
  }, [origin?.lat, origin?.lng, finalPoint?.lat, finalPoint?.lng]);

  // Re-render whenever the shot list, its endpoints, or its aim points change (e.g. after
  // setShotAimPoint writes back to Dexie and the parent's useLiveQuery re-delivers shots).
  useEffect(() => {
    renderShots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shots, armedShotId]);

  const armedIndex = shots.findIndex((s) => s.id === armedShotId);

  if (!TOKEN) {
    return (
      <div style={{ padding: 24, color: "#eef2ef" }}>
        No Mapbox token configured. Add <code>VITE_MAPBOX_TOKEN</code> to <code>.env.local</code>.
      </div>
    );
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      {armedShotId && (
        <div style={armedHudStyle}>🎯 Tap the map to set Shot {armedIndex + 1}'s aim point…</div>
      )}
    </div>
  );
}

const armedHudStyle: React.CSSProperties = {
  position: "absolute",
  top: 12,
  left: 12,
  right: 12,
  background: "rgba(245,217,10,0.95)",
  color: "#111",
  padding: "8px 12px",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  zIndex: 1
};
