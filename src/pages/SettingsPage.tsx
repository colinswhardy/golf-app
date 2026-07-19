import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { PageHeader } from "../components/PageHeader";
import { ensureDefaultClubs, listClubs, updateClubDispersion } from "../lib/courseRepo";
import { isGpsEnabled, setGpsEnabled } from "../lib/settings";
import type { Club } from "../types/domain";

/**
 * Per-club dispersion editor: manual front/back + left/right yardages (used to draw the
 * dispersion ellipse overlay on the round map — see lib/dispersion.ts), plus a per-club toggle
 * to prefer computing the ellipse from actual recorded shot history instead, when there's
 * enough of it. Edits are debounced-free (blur/change-committed) direct writes — this is a
 * low-frequency settings table, not a live-typing surface.
 */
export function SettingsPage() {
  // Seeding (a write) can't happen inside useLiveQuery's callback — Dexie runs it in a read-only
  // transaction and throws ReadOnlyError. Seed once on mount instead; the live query below just reads.
  useEffect(() => {
    ensureDefaultClubs();
  }, []);
  const clubs = useLiveQuery(() => listClubs(), []);

  const [gpsEnabled, setGpsEnabledState] = useState(isGpsEnabled);
  function toggleGps(enabled: boolean) {
    setGpsEnabledState(enabled);
    setGpsEnabled(enabled);
  }

  return (
    <div style={{ padding: 16 }}>
      <PageHeader title="Settings" />
      <p style={{ opacity: 0.8, marginBottom: 20 }}>
        Not built yet: units, default aim-point rule, strokes-gained baseline default, Supabase
        sync status.
      </p>

      <h2 style={{ fontSize: 16, marginBottom: 4 }}>Location</h2>
      <label style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <input type="checkbox" checked={gpsEnabled} onChange={(e) => toggleGps(e.target.checked)} />
        <span style={{ fontSize: 14 }}>Use live GPS on the course</span>
      </label>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 20 }}>
        When on, the round map anchors distances to your real position once you're within ~2000
        yards of a hole's tee. Turn off to always measure from the saved tee boxes instead (useful
        when reviewing a course from home, or if GPS is being unreliable). Takes effect next time
        you open a round.
      </p>

      <h2 style={{ fontSize: 16, marginBottom: 4 }}>Club dispersion</h2>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 12 }}>
        Front/back and left/right are total spread in yards (e.g. 20 = ±10y). "Actual" computes
        the ellipse from recorded shots with a known aim point instead, once there's enough of
        them, falling back to the manual values below when there isn't.
      </p>

      <div style={tableWrapStyle}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Club</th>
              <th style={thStyle}>Front/Back (y)</th>
              <th style={thStyle}>Left/Right (y)</th>
              <th style={thStyle}>Actual</th>
            </tr>
          </thead>
          <tbody>
            {clubs?.map((c) => (
              <ClubRow key={c.id} club={c} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ClubRow({ club }: { club: Club }) {
  const [frontBack, setFrontBack] = useState(club.manualFrontBackYards?.toString() ?? "");
  const [leftRight, setLeftRight] = useState(club.manualLeftRightYards?.toString() ?? "");

  function commitFrontBack() {
    const n = parseFloat(frontBack);
    updateClubDispersion(club.id, { manualFrontBackYards: Number.isFinite(n) && n >= 0 ? n : null });
  }
  function commitLeftRight() {
    const n = parseFloat(leftRight);
    updateClubDispersion(club.id, { manualLeftRightYards: Number.isFinite(n) && n >= 0 ? n : null });
  }

  return (
    <tr>
      <td style={tdStyle}>{club.name}</td>
      <td style={tdStyle}>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          value={frontBack}
          onChange={(e) => setFrontBack(e.target.value)}
          onBlur={commitFrontBack}
          style={inputStyle}
        />
      </td>
      <td style={tdStyle}>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          value={leftRight}
          onChange={(e) => setLeftRight(e.target.value)}
          onBlur={commitLeftRight}
          style={inputStyle}
        />
      </td>
      <td style={{ ...tdStyle, textAlign: "center" }}>
        <input
          type="checkbox"
          checked={!!club.useActualDispersion}
          onChange={(e) => updateClubDispersion(club.id, { useActualDispersion: e.target.checked })}
        />
      </td>
    </tr>
  );
}

const tableWrapStyle: React.CSSProperties = {
  overflowX: "auto",
  border: "1px solid #2f5c3d",
  borderRadius: 10
};

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  background: "#1a3a24",
  borderBottom: "1px solid #2f5c3d",
  whiteSpace: "nowrap"
};

const tdStyle: React.CSSProperties = {
  padding: "6px 10px",
  borderBottom: "1px solid #16241a"
};

const inputStyle: React.CSSProperties = {
  width: 72,
  padding: "6px 8px",
  background: "#0b0f0c",
  color: "#eef2ef",
  border: "1px solid #2f5c3d",
  borderRadius: 6,
  fontSize: 13
};
