import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { bearingDegrees } from "../lib/geo";
import type { LatLng, Shot } from "../types/domain";

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const PATH_SOURCE_ID = "review-path";
/** Tilt for the tee-at-bottom camera, matching the live round map. */
const FRAME_PITCH = 55;
/** Room around the fitted path: the hole bar / back button sit over the top edge on the phone
 * layout and the "tap the map" toast over the bottom, so the tee and green stay clear of both. */
const FRAME_PADDING = { top: 72, bottom: 56, left: 40, right: 40 };
/** A hole that's all putts would otherwise fit to street-level zoom and lose all context. */
const FRAME_MAX_ZOOM = 19;
/** Transient empty shot lists (Dexie briefly emits [] while a new hole's rows load) shouldn't
 * bounce the camera to the tee and back; a short debounce lets the real rows land first. */
const FRAME_DEBOUNCE_MS = 60;

interface ReviewMapProps {
  /** Shots for the hole being reviewed, sorted by shotNumber. */
  shots: Shot[];
  /** Tee box, used as a camera fallback when there are no shots recorded yet for this hole. */
  fallbackOrigin: LatLng | null;
  /** Shot id currently accepting a map tap, or null if none armed (drives marker highlight
   * and the "tap the map" HUD). */
  armedShotId: string | null;
  /** What the tap will do to the armed shot: set where it was aimed, or move where it was
   * played from. Defaults to "target". */
  armedAction?: "target" | "move";
  /** Forward map taps to onMapClick even without an armed shot — e.g. penalty-point entry.
   * Defaults to false so idle taps stay inert. */
  clickArmed?: boolean;
  /** Fires with the tapped coordinate while a shot (or clickArmed mode) is armed. */
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
export function ReviewMap({ shots, fallbackOrigin, armedShotId, armedAction = "target", clickArmed = false, onMapClick }: ReviewMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const shotMarkersRef = useRef<mapboxgl.Marker[]>([]);
  const aimMarkersRef = useRef<mapboxgl.Marker[]>([]);

  const stateRef = useRef({ shots, armedShotId, clickArmed, onMapClick });
  stateRef.current = { shots, armedShotId, clickArmed, onMapClick };

  // Everything the camera has to keep in frame: every stroke's start and finish. Falls back to
  // the tee box for a hole with nothing recorded yet.
  const framePoints: LatLng[] = [];
  for (const s of shots) {
    framePoints.push(s.startPoint);
    if (s.endPoint) framePoints.push(s.endPoint);
  }
  if (!framePoints.length && fallbackOrigin) framePoints.push(fallbackOrigin);
  const origin = framePoints[0] ?? null;
  const finalPoint = shots.length ? (shots[shots.length - 1].endPoint ?? shots[shots.length - 1].startPoint) : null;
  const framePointsRef = useRef({ framePoints, origin, finalPoint });
  framePointsRef.current = { framePoints, origin, finalPoint };

  /**
   * Frames the hole: fits every path point with the tee at the bottom and the green at the top
   * (bearing tee→last point, tilted like the live map). A fit rather than "centre on the tee at
   * a fixed zoom" so a long par 5 fills a tall desktop frame instead of running off the top, and
   * a short par 3 doesn't sit in a sea of neighbouring holes. First placement is instant — the
   * data almost never exists on the very first render, and a fly-in from the generic fallback
   * would be disorienting; every later change (a new hole, rows finishing loading) eases.
   */
  const hasPlacedCameraRef = useRef(false);
  function frameHole() {
    const map = mapRef.current;
    const { framePoints: pts, origin: o, finalPoint: f } = framePointsRef.current;
    if (!map || !o) return;
    const duration = hasPlacedCameraRef.current ? 600 : 0;
    hasPlacedCameraRef.current = true;
    const spread = f && (f.lat !== o.lat || f.lng !== o.lng);
    if (!spread) {
      map.easeTo({ center: [o.lng, o.lat], zoom: 17, bearing: 0, pitch: 0, duration });
      return;
    }
    const bounds = new mapboxgl.LngLatBounds();
    for (const p of pts) bounds.extend([p.lng, p.lat]);
    map.fitBounds(bounds, {
      bearing: bearingDegrees(o, f),
      pitch: FRAME_PITCH,
      padding: FRAME_PADDING,
      maxZoom: FRAME_MAX_ZOOM,
      duration
    });
  }
  const frameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function scheduleFrame() {
    if (frameTimerRef.current) clearTimeout(frameTimerRef.current);
    frameTimerRef.current = setTimeout(frameHole, FRAME_DEBOUNCE_MS);
  }

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
      el.style.cssText = `width:25px;height:25px;border-radius:50%;background:${isArmed ? "#ffc043" : "#ffffff"};border:2px solid rgba(0,0,0,.65);box-shadow:0 2px 7px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#111;`;
      el.textContent = String(i + 1);
      shotMarkersRef.current.push(
        new mapboxgl.Marker({ element: el, anchor: "center" }).setLngLat([s.startPoint.lng, s.startPoint.lat]).addTo(map)
      );

      // Only hand-set targets get a marker — default-applied targets (green/pin/fairway) would
      // just re-draw geometry the player can already see.
      if (s.targetPoint && s.targetSource === "manual") {
        const aimEl = document.createElement("div");
        aimEl.style.cssText = "width:16px;height:16px;border-radius:50%;background:#ff5a5a;border:2px solid #fff;box-shadow:0 0 0 4px rgba(255,90,90,.2);";
        aimMarkersRef.current.push(
          new mapboxgl.Marker({ element: aimEl, anchor: "center" })
            .setLngLat([s.targetPoint.lng, s.targetPoint.lat])
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

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center: [center.lng, center.lat],
      zoom: 17
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
        paint: { "line-color": "#ffc043", "line-width": 3 }
      });
      renderShots();
    });

    map.on("click", (e) => {
      const { armedShotId: curArmed, clickArmed: curClickArmed, onMapClick: curOnClick } = stateRef.current;
      if (!curArmed && !curClickArmed) return;
      curOnClick({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });

    // The frame changes shape when the phone/desktop layout flips or the window is resized, and
    // a fit computed for the old shape leaves the hole cropped or tiny in the new one.
    map.on("resize", scheduleFrame);

    return () => {
      if (frameTimerRef.current) clearTimeout(frameTimerRef.current);
      map.remove();
      mapRef.current = null;
      shotMarkersRef.current = [];
      aimMarkersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-frame when the hole's set of strokes changes (a different hole, rows finishing loading,
  // a stroke added or removed) — but NOT when a stroke merely moves: nudging a position from
  // the shot list shouldn't send the camera drifting after it. `shots`/`fallbackOrigin` come
  // from async useLiveQuery chains that are almost never resolved on the first render, which is
  // why the mount effect alone can't place the camera.
  const frameKey = shots.length ? shots.map((s) => s.id).join("|") : `tee:${fallbackOrigin?.lat ?? ""},${fallbackOrigin?.lng ?? ""}`;
  useEffect(() => {
    if (!mapRef.current || !origin) return;
    scheduleFrame();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameKey]);

  // Re-render whenever the shot list, its endpoints, or its aim points change (e.g. after
  // setShotAimPoint writes back to Dexie and the parent's useLiveQuery re-delivers shots).
  useEffect(() => {
    renderShots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shots, armedShotId]);

  const armedIndex = shots.findIndex((s) => s.id === armedShotId);

  if (!TOKEN) {
    return (
      <div className="page">
        <div className="note note--danger">
          No Mapbox token configured. Add <code>VITE_MAPBOX_TOKEN</code> to <code>.env.local</code>.
        </div>
      </div>
    );
  }

  return (
    <div className="map-root">
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      {armedShotId && (
        <div className="toast glass" style={{ top: "auto", bottom: 12, color: "var(--warn)" }}>
          {armedAction === "move"
            ? `Tap the map where shot ${armedIndex + 1} was played from`
            : `Tap the map to set shot ${armedIndex + 1}'s target`}
        </div>
      )}
    </div>
  );
}
