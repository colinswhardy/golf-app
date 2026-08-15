import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import * as turf from "@turf/turf";
import { applyTouchDragOffset } from "../lib/mapTouch";
import { Icon } from "./ui";
import type { ChipMark } from "../lib/roundRepo";
import type { LatLng, Lie } from "../types/domain";

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const SATELLITE_STYLE = "mapbox://styles/mapbox/satellite-streets-v12";
const GREEN_BUFFER_YARDS = 25;
/** How long the pin must be held before it starts moving. Short taps do nothing on the pin —
 * putt taps land on the map around it, never on it. */
const PIN_MOVE_HOLD_MS = 450;
/** Finger drift allowed before a hold is treated as a map pan attempt and cancelled. */
const HOLD_MOVE_TOLERANCE_PX = 8;

/** The lies you actually chip from around a green. "Debris" maps to the recovery lie — trees,
 * leaves, hardpan junk beyond the mapped surfaces. */
const CHIP_LIES: { label: string; lie: Lie }[] = [
  { label: "Debris", lie: "recovery" },
  { label: "Fringe", lie: "fringe" },
  { label: "Fairway", lie: "fairway" },
  { label: "Rough", lie: "rough" }
];

interface GreenMapProps {
  /** The hole's green polygon, used to frame the camera (buffered 25y so fringe, collar and
   * apron lies are placeable). Null = no mapped green; camera centres on fallbackCenter. */
  greenPolygon: GeoJSON.Polygon | null;
  fallbackCenter: LatLng;
  /** Existing pin for this hole/round, when re-marking. */
  initialPin: LatLng | null;
  holeNumber: number;
  onFinish: (pin: LatLng, puttStarts: LatLng[], chips: ChipMark[]) => void;
  onClose: () => void;
}

/**
 * Green-marking screen. The FIRST tap sets the pin and the screen moves straight on to marking
 * putt starts — no confirmation step. Holding the pin (long-press) picks it up to move it.
 * Chips played around the green (phone left in the cart) are added via the Chip button: tap
 * where the chip was from, then say what it was played off.
 *
 * A separate full-screen map component — deliberately NOT an extension of CourseMap (different
 * interaction model; that component is the most battle-tested code in the app and stays
 * untouched). Top-down camera: precision tapping wants no pitch. Course polygons stay invisible,
 * as everywhere.
 */
export function GreenMap({ greenPolygon, fallbackCenter, initialPin, holeNumber, onFinish, onClose }: GreenMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const pinMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const puttMarkersRef = useRef<mapboxgl.Marker[]>([]);
  const chipMarksRef = useRef<{ marker: mapboxgl.Marker; lie: Lie }[]>([]);
  /** Add-order of putts and chips, so one Undo button can remove whichever came last. */
  const markOrderRef = useRef<("putt" | "chip")[]>([]);

  const [pin, setPin] = useState<LatLng | null>(initialPin);
  const [movingPin, setMovingPin] = useState(false);
  const [puttCount, setPuttCount] = useState(0);
  const [chipCount, setChipCount] = useState(0);
  const [placingChip, setPlacingChip] = useState(false);
  /** A chip has been placed and is waiting for its lie — map taps pause until it's picked. */
  const [chipLiePending, setChipLiePending] = useState(false);

  const stateRef = useRef({ pin, placingChip, chipLiePending });
  stateRef.current = { pin, placingChip, chipLiePending };

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

  /** Taps on a marker must never fall through to the map — a tap on the pin (or an existing
   * putt dot) would otherwise mint a new putt underneath it. */
  function swallowClicks(el: HTMLElement) {
    el.addEventListener("click", (e) => e.stopPropagation());
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  /**
   * Long-press-to-move for the pin. Mapbox's built-in draggable starts a drag on ANY touch, which
   * fights with fast putt-tapping right beside the flag — so the pin only moves after a deliberate
   * hold. Implemented by hand: hold PIN_MOVE_HOLD_MS without drifting, the marker captures the
   * pointer and follows it (through applyTouchDragOffset, the canonical thumb-offset — REVISION-SPEC
   * constraint 2), and release drops it.
   */
  function attachPinHold(el: HTMLDivElement, dot: HTMLDivElement, marker: mapboxgl.Marker) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let dragging = false;
    let start: { x: number; y: number } | null = null;

    const cancelTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    el.style.touchAction = "none";
    swallowClicks(el);
    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      start = { x: e.clientX, y: e.clientY };
      dragging = false;
      cancelTimer();
      timer = setTimeout(() => {
        const map = mapRef.current;
        if (!map) return;
        dragging = true;
        setMovingPin(true);
        map.dragPan.disable();
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // Pointer already gone (finger lifted in the same frame) — the up handler cleans up.
        }
        dot.style.transform = "scale(1.35)";
        navigator.vibrate?.(30);
      }, PIN_MOVE_HOLD_MS);
    });
    el.addEventListener("pointermove", (e) => {
      if (dragging) {
        const map = mapRef.current;
        if (!map) return;
        const rect = map.getContainer().getBoundingClientRect();
        marker.setLngLat(map.unproject([e.clientX - rect.left, e.clientY - rect.top]));
        setPin(applyTouchDragOffset(map, marker));
      } else if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > HOLD_MOVE_TOLERANCE_PX) {
        cancelTimer();
      }
    });
    const end = () => {
      cancelTimer();
      if (dragging) {
        dragging = false;
        mapRef.current?.dragPan.enable();
        dot.style.transform = "";
        const pos = marker.getLngLat();
        setPin({ lat: pos.lat, lng: pos.lng });
        setMovingPin(false);
      }
      start = null;
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  function placePin(point: LatLng) {
    const map = mapRef.current;
    if (!map) return;
    if (!pinMarkerRef.current) {
      const el = makeMarkerElement("⛳", "#ff5a5a", 28);
      const marker = new mapboxgl.Marker({ element: el, anchor: "center" }).setLngLat([point.lng, point.lat]).addTo(map);
      attachPinHold(el, el.firstChild as HTMLDivElement, marker);
      pinMarkerRef.current = marker;
    } else {
      pinMarkerRef.current.setLngLat([point.lng, point.lat]);
    }
    setPin(point);
  }

  function makeDraggableMark(point: LatLng, label: string, background: string): mapboxgl.Marker {
    const map = mapRef.current!;
    const el = makeMarkerElement(label, background, 26);
    swallowClicks(el);
    const marker = new mapboxgl.Marker({ element: el, draggable: true, anchor: "center" })
      .setLngLat([point.lng, point.lat])
      .addTo(map);
    marker.on("drag", () => {
      const dragMap = mapRef.current;
      if (dragMap) applyTouchDragOffset(dragMap, marker);
    });
    return marker;
  }

  function addPuttMarker(point: LatLng) {
    if (!mapRef.current) return;
    const index = puttMarkersRef.current.length + 1;
    puttMarkersRef.current.push(makeDraggableMark(point, String(index), "#3ddc97"));
    markOrderRef.current.push("putt");
    setPuttCount(puttMarkersRef.current.length);
  }

  function addChipMarker(point: LatLng) {
    if (!mapRef.current) return;
    const index = chipMarksRef.current.length + 1;
    // Lie filled in by the chooser that opens right after; "rough" is only the never-shown default.
    chipMarksRef.current.push({ marker: makeDraggableMark(point, `C${index}`, "#f0a33a"), lie: "rough" });
    markOrderRef.current.push("chip");
    setChipCount(chipMarksRef.current.length);
    setPlacingChip(false);
    setChipLiePending(true);
  }

  function setPendingChipLie(lie: Lie) {
    const chip = chipMarksRef.current[chipMarksRef.current.length - 1];
    if (chip) chip.lie = lie;
    setChipLiePending(false);
  }

  function undoLastMark() {
    const kind = markOrderRef.current.pop();
    if (kind === "putt") {
      puttMarkersRef.current.pop()?.remove();
      setPuttCount(puttMarkersRef.current.length);
    } else if (kind === "chip") {
      chipMarksRef.current.pop()?.marker.remove();
      setChipCount(chipMarksRef.current.length);
      setChipLiePending(false);
    }
  }

  function handleFinish() {
    const curPin = stateRef.current.pin;
    if (!curPin) return;
    const putts = puttMarkersRef.current.map((m) => {
      const pos = m.getLngLat();
      return { lat: pos.lat, lng: pos.lng } as LatLng;
    });
    const chips: ChipMark[] = chipMarksRef.current.map(({ marker, lie }) => {
      const pos = marker.getLngLat();
      return { point: { lat: pos.lat, lng: pos.lng }, lie };
    });
    onFinish(curPin, putts, chips);
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
      const cur = stateRef.current;
      if (cur.chipLiePending) return; // finish the chip's lie first
      if (!cur.pin) {
        // First touch IS the pin — no confirmation step, straight on to putts.
        placePin(clicked);
      } else if (cur.placingChip) {
        addChipMarker(clicked);
      } else {
        addPuttMarker(clicked);
      }
    });

    // Re-marking an already-marked hole: show the existing pin immediately.
    if (initialPin) placePin(initialPin);

    return () => {
      map.remove();
      mapRef.current = null;
      pinMarkerRef.current = null;
      puttMarkersRef.current = [];
      chipMarksRef.current = [];
      markOrderRef.current = [];
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

  const hint = !pin
    ? "Tap where the pin was — first tap sets it"
    : movingPin
      ? "Slide the pin, then let go"
      : chipLiePending
        ? "What was that chip played from?"
        : placingChip
          ? "Tap where you chipped from"
          : `Tap each putt's start, in order · ${puttCount} marked · hold ⛳ to move it`;

  return (
    <div className="map-root" style={{ position: "absolute", inset: 0, zIndex: 30, background: "var(--bg)" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

      <div className="hole-bar glass" style={{ flexDirection: "column", gap: 2, padding: "9px 18px", borderRadius: 16 }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>Hole {holeNumber} · Green</span>
        <span className="tiny dim" style={{ textAlign: "center" }}>
          {hint}
        </span>
      </div>

      {/* Lie chooser for the chip just placed. Modal by construction: map taps are ignored and
          Finish is hidden until one of these is picked (Undo remains, to kill the chip instead). */}
      {chipLiePending && (
        <div
          className="glass"
          style={{
            position: "absolute",
            left: 12,
            right: 12,
            bottom: "calc(84px + var(--safe-b, 0px))",
            zIndex: 31,
            borderRadius: 16,
            padding: "12px 14px"
          }}
        >
          <div className="small bold mb-2">Chip {chipCount} — played from?</div>
          <div className="row" style={{ gap: 8 }}>
            {CHIP_LIES.map((c) => (
              <button key={c.lie} className="chip" style={{ flex: 1, justifyContent: "center" }} onClick={() => setPendingChipLie(c.lie)}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="round-bar">
        {!pin ? (
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
        ) : (
          <>
            <button className="btn btn--sm btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn--sm" onClick={undoLastMark} disabled={puttCount === 0 && chipCount === 0}>
              Undo
            </button>
            <button
              className={`btn btn--sm${placingChip ? " btn--primary" : ""}`}
              onClick={() => setPlacingChip((v) => !v)}
              disabled={chipLiePending}
            >
              <Icon.plus size={14} /> Chip
            </button>
            {/* Zero putts is valid — a chip-in or holed bunker shot. */}
            {!chipLiePending && (
              <button className="btn btn--sm btn--primary" onClick={handleFinish}>
                <Icon.check size={15} /> Finish · {puttCount}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
