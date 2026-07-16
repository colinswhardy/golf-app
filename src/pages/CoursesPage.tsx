import { useLiveQuery } from "dexie-react-hooks";
import { Link } from "react-router-dom";
import { db } from "../lib/db";
import { PageHeader } from "../components/PageHeader";

export function CoursesPage() {
  const courses = useLiveQuery(
    async () => (await db.courses.toArray()).filter((c) => !c.deletedAt),
    []
  );

  return (
    <div style={{ padding: 16 }}>
      <PageHeader title="Courses" />

      {!courses?.length && (
        <p style={{ opacity: 0.8 }}>
          No courses imported yet. Use <Link to="/imports">Data Imports</Link> to bring in a course
          from an Overpass Turbo export.
        </p>
      )}

      <ul style={{ listStyle: "none", padding: 0 }}>
        {courses?.map((c) => (
          <li key={c.id}>
            <Link to={`/round/${c.id}`}>{c.name}</Link>
          </li>
        ))}
      </ul>

      <p style={{ marginTop: 24, opacity: 0.7, fontSize: 13 }}>
        No course loaded yet? <Link to="/round/demo">Preview the in-round map view</Link> using just
        your current GPS position and a tappable target — useful for testing on your phone before any
        course data exists.
      </p>
    </div>
  );
}
