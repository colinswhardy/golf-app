import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { parseOverpassGeoJson, type ParsedCourse } from "../lib/importOverpass";
import { saveImportedCourse } from "../lib/courseRepo";

export function DataImportsPage() {
  const [parsed, setParsed] = useState<ParsedCourse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedCourseId, setSavedCourseId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  async function handleFile(file: File) {
    setError(null);
    setSavedCourseId(null);
    try {
      const text = await file.text();
      const geojson = JSON.parse(text);
      if (geojson.type !== "FeatureCollection") {
        throw new Error('Not a GeoJSON FeatureCollection — export from Overpass Turbo using Export → GeoJSON.');
      }
      setParsed(parseOverpassGeoJson(geojson));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setParsed(null);
    }
  }

  async function handleSave() {
    if (!parsed) return;
    setSaving(true);
    try {
      const { courseId } = await saveImportedCourse(parsed);
      setSavedCourseId(courseId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const featureCounts = parsed
    ? parsed.features.reduce<Record<string, number>>((acc, f) => {
        acc[f.featureType] = (acc[f.featureType] ?? 0) + 1;
        return acc;
      }, {})
    : null;

  return (
    <div style={{ padding: 16 }}>
      <PageHeader title="Data Imports" />

      <p style={{ opacity: 0.8, fontSize: 14 }}>
        Import a course from an Overpass Turbo GeoJSON export (Export → GeoJSON after running your
        query). Re-importing a course with the same name adds a new version rather than duplicating it.
      </p>

      <input
        ref={fileInputRef}
        type="file"
        accept=".geojson,.json,application/geo+json,application/json"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />
      <button onClick={() => fileInputRef.current?.click()} style={buttonStyle}>
        Choose GeoJSON file…
      </button>

      {error && <p style={{ color: "#ff8080", marginTop: 12 }}>{error}</p>}

      {parsed && (
        <div style={{ marginTop: 20 }}>
          <h2 style={{ fontSize: 16 }}>{parsed.name}</h2>
          <p style={{ opacity: 0.8, fontSize: 14 }}>{parsed.holes.length} holes detected.</p>

          <table style={{ fontSize: 13, borderCollapse: "collapse", marginTop: 8 }}>
            <tbody>
              {Object.entries(featureCounts ?? {}).map(([type, count]) => (
                <tr key={type}>
                  <td style={{ padding: "2px 12px 2px 0", opacity: 0.8 }}>{type}</td>
                  <td>{count}</td>
                </tr>
              ))}
              <tr>
                <td style={{ padding: "2px 12px 2px 0", opacity: 0.8 }}>tee boxes</td>
                <td>{parsed.teeBoxes.length}</td>
              </tr>
            </tbody>
          </table>

          {parsed.warnings.length > 0 && (
            <div style={{ marginTop: 12, background: "#3a2a0b", border: "1px solid #6b4d16", borderRadius: 8, padding: 10 }}>
              <strong style={{ fontSize: 13 }}>Warnings</strong>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12.5 }}>
                {parsed.warnings.map((w, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {!savedCourseId ? (
            <button onClick={handleSave} disabled={saving} style={{ ...buttonStyle, marginTop: 16 }}>
              {saving ? "Saving…" : "Save to this device"}
            </button>
          ) : (
            <div style={{ marginTop: 16 }}>
              <p style={{ color: "#8fd694" }}>Saved.</p>
              <button onClick={() => navigate("/courses")} style={buttonStyle}>
                Go to Courses →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  padding: "10px 14px",
  background: "#1a3a24",
  color: "#eef2ef",
  border: "1px solid #2f5c3d",
  borderRadius: 8,
  fontSize: 14,
  cursor: "pointer"
};
