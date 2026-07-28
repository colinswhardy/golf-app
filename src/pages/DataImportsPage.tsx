import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppBar, Badge, Button, Icon, Note, Page, Section } from "../components/ui";
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
      const geojson = JSON.parse(await file.text());
      if (geojson.type !== "FeatureCollection") {
        throw new Error("Not a GeoJSON FeatureCollection — export from Overpass Turbo using Export → GeoJSON.");
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
    <Page>
      <AppBar title="Data imports" />

      <Section hint="Import a course from an Overpass Turbo GeoJSON export. Re-importing a course adds a new version rather than replacing it, so rounds already recorded keep resolving against the geometry they were played on.">
        <Button variant="primary" onClick={() => fileInputRef.current?.click()}>
          <Icon.upload size={16} /> Choose GeoJSON file
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".geojson,.json,application/geo+json,application/json"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) handleFile(file);
          }}
        />
      </Section>

      {error && (
        <div className="mt-2">
          <Note tone="danger">{error}</Note>
        </div>
      )}

      {parsed && (
        <Section title="Preview">
          <div className="card">
            <div className="card__title">{parsed.name}</div>
            <div className="card__meta">{parsed.holes.length} holes detected</div>

            <div className="row row--wrap mt-2" style={{ gap: 6 }}>
              {Object.entries(featureCounts ?? {}).map(([type, count]) => (
                <Badge key={type}>
                  {type.replace(/_/g, " ")} {count}
                </Badge>
              ))}
              <Badge tone="accent">tee boxes {parsed.teeBoxes.length}</Badge>
            </div>

            {parsed.warnings.length > 0 && (
              <div className="mt-2">
                <Note tone="warn">
                  <div className="bold mb-1">Warnings</div>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {parsed.warnings.map((w, i) => (
                      <li key={i} style={{ marginBottom: 4 }}>
                        {w}
                      </li>
                    ))}
                  </ul>
                </Note>
              </div>
            )}

            <div className="mt-3">
              {!savedCourseId ? (
                <Button variant="primary" onClick={handleSave} disabled={saving}>
                  {saving ? "Saving…" : "Save to this device"}
                </Button>
              ) : (
                <div className="row row--wrap" style={{ gap: 8 }}>
                  <Note tone="ok">Saved.</Note>
                  <Button onClick={() => navigate("/courses")}>Go to courses</Button>
                </div>
              )}
            </div>
          </div>
        </Section>
      )}
    </Page>
  );
}
