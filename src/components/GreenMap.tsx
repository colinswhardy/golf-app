import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import * as turf from "@turf/turf";
import { applyTouchDragOffset } from "../lib/mapTouch";
import { Icon } from "./ui";
import type { LatLng } from "../types/domain";

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const SATELLITE_STYLE = "mapbox://styles/mapbox/satellite-streets-v12";
const GREEN_BUFFER_YARDS = 25;

interface GreenMapProps {
  /** The hole's green polygon, used to frame the camera (buffered 25y so fringe, collar and
   * apron lies are placeable). Null = no mapped green; camera centres on fallbackCenter. */
  greenPolygon: GeoJSON.Polygon | null;
  fallbackCenter: LatLng;
  /** Existing pin for this hole/round, when re-marking. */
  initialPin: LatLng | null;
  /** Existing putt starts, in order, when re-marking from review — pre-placed as draggable
   * markers so a fix is a nudge, not a redo. */
  initialPuttStarts?: LatLng[];
  holeNumber: number;
  onFinish: (pin: LatLng, puttStarts: LatLng[]) => void;
  onClose: () => void;
}

/**
 * Green-marking screen: pin first, then each putt's start position in order, then Finish.
 * A separate full-screen map component — deliberately NOT an extension of CourseMap (different
 * interaction model; that component is the most battle-tested code in the app and stays
 * untouched). Top-down camera: precision tapping wants no pitch. Course polygons stay invisible,
 * as everywhere.
 */
export function GreenMap({ greenPolygon, fallbackCenter, initialPin, initialPuttStarts, holeNumber, onFinish, onClose }: GreenMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const pinMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const puttMarkersRef = useRef<mapboxgl.Marker[]>([]);

  const [mode, setMode] = useState<"pin" | "putts">("pin");
  const [pin, setPin] = useState<LatLng | null>(initialPin);
  const [puttCount, setPuttCount] = useState(0);

  const stateRef = useRef({ mode, pin });
  stateRef.current = { mode, pin };

  function makeMarkerElement(label: string, background: string, size: number): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "map-touch-target";
    const dot = document.createElement("div");
    dot.className = "map-touch-dot";
    dot.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:${background};border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:#fff;`;
    dot.textContent = label;
    el.appendChild(dot);
    return el;
  }

  function placePin(point: LatLng) {
    const map = mapRef.current;
    if (!map) return;
    if (!pinMarkerRef.current) {
      const marker = new mapboxgl.Marker({
        element: makeMarkerElement("⛳", "#ff5a5a", 28),
        draggable: true,
        anchor: "center"
      })
        .setLngLat([point.lng, point.lat])
        .addTo(map);
      marker.on("drag", () => {
        const dragMap = mapRef.current;
        if (dragMap) setPin(applyTouchDragOffset(dragMap, marker));
      });
      marker.on("dragend", () => {
        const pos = marker.getLngLat();
        setPin({ lat: pos.lat, lng: pos.lng });
      });
      pinMarkerRef.current = marker;
    } else {
      pinMarkerRef.current.setLngLat([point.lng, point.lat]);
    }
    setPin(point);
  }

  function addPuttMarker(point: LatLng) {
    const map = mapRef.current;
    if (!map) return;
    const index = puttMarkersRef.current.length + 1;
    const marker = new mapboxgl.Marker({
      element: makeMarkerElement(String(index), "#3ddc97", 26),
      draggable: true,
      anchor: "center"
    })
      .setLngLat([point.lng, point.lat])
      .addTo(map);
    marker.on("drag", () => {
      const dragMap = mapRef.current;
      if (dragMap) applyTouchDragOffset(dragMap, marker);
    });
    puttMarkersRef.current.push(marker);
    setPuttCount(puttMarkersRef.current.length);
  }

  function removeLastPutt() {
    puttMarkersRef.current.pop()?.remove();
    setPuttCount(puttMarkersRef.current.length);
  }

  function handleFinish() {
    const curPin = stateRef.current.pin;
    if (!curPin) return;
    const putts = puttMarkersRef.current.map((m) => {
      const pos = m.getLngLat();
      return { lat: pos.lat, lng: pos.lng } as LatLng;
    });
    onFinish(curPin, putts);
  }

  // --- Map init (once). Every marker ref is nulled in cleanup — StrictMode double-mounts in dev,
  // and a ref left pointing at a marker orphaned from the destroyed map means the feature
  // silently never renders on the real mount. ---
  useEffect(() => {
    if (!TOKEN || !containerRef.current || mapRef.current) return;
    mapboxgl.accessToken = TOKEN;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: SATELLITE_STYLE,
      center: [fallbackCenter.lng, fallbackCenter.lat],
      zoom: 18.5
    });
    mapRef.current = map;

    // Frame the green buffered by 25 yards so fringe/collar/apron putts are placeable.
    if (greenPolygon) {
      try {
        const buffered = turf.buffer(turf.feature(greenPolygon), GREEN_BUFFER_YARDS, { units: "yards" });
        if (buffered) {
          const [minX, minY, maxX, maxY] = turf.bbox(buffered);
          map.fitBounds(
            [
              [minX, minY],
              [maxX, maxY]
            ],
            { padding: 40, duration: 0 }
          );
        }
      } catch {
        // Degenerate polygon: stay on the fallback centre/zoom.
      }
    }

    map.on("click", (e) => {
      const clicked = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      if (stateRef.current.mode === "pin") placePin(clicked);
      else addPuttMarker(clicked);
    });

    // Re-marking an already-marked hole: show the existing pin and putts immediately.
    if (initialPin) placePin(initialPin);
    for (const p of initialPuttStarts ?? []) addPuttMarker(p);

    return () => {
      map.remove();
      mapRef.current = null;
      pinMarkerRef.current = null;
      puttMarkersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!TOKEN) {
    return (
      <div className="map-root" style={{ position: "absolute", inset: 0, zIndex: 30, background: "var(--bg)" }}>
        <div className="page">
          <div className="note note--danger">No Mapbox token configured.</div>
          <button className="btn mt-2" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="map-root" style={{ position: "absolute", inset: 0, zIndex: 30, background: "var(--bg)" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

      <div className="hole-bar glass" style={{ flexDirection: "column", gap: 2, padding: "9px 18px", borderRadius: 16 }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>Hole {holeNumber} · Green</span>
        <span className="tiny dim" style={{ textAlign: "center" }}>
          {mode === "pin"
            ? pin
              ? "Pin placed — drag to fine-tune, or tap to move"
              : "Tap where the pin was"
            : `Tap each putt's start, in order · ${puttCount} marked`}
        </span>
      </div>

      <div className="round-bar">
        {mode === "pin" ? (
          <>
            <button className="btn btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn--primary" onClick={() => setMode("putts")} disabled={!pin}>
              Next: putts <Icon.chevron size={15} />
            </button>
          </>
        ) : (
          <>
            <button className="btn btn--sm btn--ghost" onClick={() => setMode("pin")}>
              <Icon.back size={14} /> Pin
            </button>
            <button className="btn btn--sm" onClick={removeLastPutt} disabled={puttCount === 0}>
              Undo putt
            </button>
            {/* Zero putts is valid — a chip-in or holed bunker shot. */}
            <button className="btn btn--sm btn--primary" onClick={handleFinish}>
              <Icon.check size={15} /> Finish · {puttCount}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
