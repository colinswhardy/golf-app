import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../lib/db";
import { getHolesForVersion, getLatestCourseVersion } from "../lib/courseRepo";
import { AppBar, Badge, EmptyState, Icon, Page, Section } from "../components/ui";

export function CoursesPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  // Hole counts come from each course's latest version rather than being assumed
  // — placeholder/partial imports genuinely aren't all 18 holes.
  const courses = useLiveQuery(async () => {
    const all = (await db.courses.toArray()).filter((c) => !c.deletedAt);
    return Promise.all(
      all.map(async (course) => {
        const version = await getLatestCourseVersion(course.id);
        const holes = version ? await getHolesForVersion(version.id) : [];
        return { course, holeCount: holes.length };
      })
    );
  }, []);

  const filtered = useMemo(() => {
    if (!courses) return [];
    const q = query.trim().toLowerCase();
    const matched = q ? courses.filter((c) => c.course.name.toLowerCase().includes(q)) : courses;
    return [...matched].sort((a, b) => {
      const ta = a.course.lastSelectedAt ? Date.parse(a.course.lastSelectedAt) : 0;
      const tb = b.course.lastSelectedAt ? Date.parse(b.course.lastSelectedAt) : 0;
      if (tb !== ta) return tb - ta;
      return a.course.name.localeCompare(b.course.name);
    });
  }, [courses, query]);

  async function open(courseId: string) {
    await db.courses.update(courseId, { lastSelectedAt: new Date().toISOString() });
    navigate(`/round/${courseId}`);
  }

  return (
    <Page>
      <AppBar title="Courses" subtitle={courses ? `${courses.length} available` : undefined} />

      <div className="search mb-3">
        <span className="search__icon">
          <Icon.search size={17} />
        </span>
        <input
          className="field field--search"
          type="text"
          placeholder="Search courses"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button className="search__clear" onClick={() => setQuery("")} aria-label="Clear search">
            <Icon.close size={16} />
          </button>
        )}
      </div>

      {!courses ? (
        <div className="card dim small">Loading courses…</div>
      ) : courses.length === 0 ? (
        <EmptyState title="No courses imported yet">
          Bring one in from an Overpass Turbo export via{" "}
          <Link to="/imports" className="accent bold">
            Data Imports
          </Link>
          .
        </EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState icon="🔍" title={`Nothing matching "${query}"`} />
      ) : (
        <div className="stack">
          {filtered.map(({ course, holeCount }) => (
            <button key={course.id} className="card card--interactive" onClick={() => open(course.id)}>
              <div className="row row--between mb-2">
                <div className="card__title truncate grow">{course.name}</div>
                {course.isFeatured && <Badge tone="accent">Bundled</Badge>}
              </div>
              <div className="row row--between">
                <span className="small dim">
                  {holeCount} {holeCount === 1 ? "hole" : "holes"}
                  {course.lastSelectedAt
                    ? ` · played ${new Date(course.lastSelectedAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric"
                      })}`
                    : ""}
                </span>
                <span className="accent row" style={{ gap: 4, fontSize: 12.5, fontWeight: 700 }}>
                  Play <Icon.chevron size={15} />
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      <Section title="Other">
        <div className="stack">
          <Link to="/round/demo" className="list-row">
            <span className="row">
              <Icon.target size={18} />
              <span>Preview the map view (demo)</span>
            </span>
            <Icon.chevron size={16} />
          </Link>
          <Link to="/imports" className="list-row">
            <span className="row">
              <Icon.upload size={18} />
              <span>Import a course</span>
            </span>
            <Icon.chevron size={16} />
          </Link>
        </div>
      </Section>
    </Page>
  );
}
