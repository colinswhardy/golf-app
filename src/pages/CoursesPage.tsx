import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Link, useNavigate } from "react-router-dom";
import { db } from "../lib/db";
import { PageHeader } from "../components/PageHeader";

export function CoursesPage() {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");

  const courses = useLiveQuery(
    async () => (await db.courses.toArray()).filter((c) => !c.deletedAt),
    []
  );

  const handleSelectCourse = async (courseId: string) => {
    try {
      await db.courses.update(courseId, {
        lastSelectedAt: new Date().toISOString()
      });
    } catch (e) {
      console.error("Failed to update lastSelectedAt:", e);
    }
    navigate(`/round/${courseId}`);
  };

  // Filter courses based on search query
  const query = searchQuery.trim().toLowerCase();
  
  const filteredCourses = courses
    ? courses.filter((c) => c.name.toLowerCase().includes(query))
    : [];

  // Group into featured and non-featured
  const featured = filteredCourses.filter((c) => c.isFeatured);
  const others = filteredCourses.filter((c) => !c.isFeatured);

  // Sort non-featured by recency (lastSelectedAt desc), then name asc
  others.sort((a, b) => {
    const timeA = a.lastSelectedAt ? new Date(a.lastSelectedAt).getTime() : 0;
    const timeB = b.lastSelectedAt ? new Date(b.lastSelectedAt).getTime() : 0;
    if (timeB !== timeA) return timeB - timeA;
    return a.name.localeCompare(b.name);
  });

  return (
    <div style={{ padding: "16px 20px", maxWidth: 600, margin: "0 auto", minHeight: "100%", background: "#0b0f0c" }}>
      <PageHeader title="Courses" />

      {/* Modern Search Bar */}
      <div style={{ position: "relative", marginBottom: 20 }}>
        <input
          type="text"
          placeholder="Search golf courses..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={searchInputStyle}
        />
        <span style={searchIconStyle}>🔍</span>
        {searchQuery && (
          <button
            onClick={() => setSearchQuery("")}
            style={clearButtonStyle}
            aria-label="Clear search"
          >
            ×
          </button>
        )}
      </div>

      {!courses && (
        <p style={{ opacity: 0.5, textAlign: "center", padding: 20 }}>Loading courses...</p>
      )}

      {courses && courses.length === 0 && (
        <div style={emptyStateStyle}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>⛳</div>
          <p style={{ margin: 0, opacity: 0.8 }}>No courses imported yet.</p>
          <p style={{ margin: "8px 0 0 0", fontSize: 13, opacity: 0.6 }}>
            Use <Link to="/imports" style={{ color: "#10b981", textDecoration: "underline" }}>Data Imports</Link> to bring in a course from an Overpass Turbo export.
          </p>
        </div>
      )}

      {courses && courses.length > 0 && filteredCourses.length === 0 && (
        <p style={{ opacity: 0.5, textAlign: "center", padding: 24, fontSize: 13 }}>
          No courses matching "{searchQuery}"
        </p>
      )}

      {/* Featured Courses Grid */}
      {featured.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h2 style={sectionHeaderStyle}>Featured Courses</h2>
          <div style={featuredGridStyle}>
            {featured.map((c) => {
              // Custom rendering adjustments for bundled names if desired
              const displayName = c.name
                .replace(" Golfers Club", "")
                .replace(" Golf Club", "");
              
              return (
                <div
                  key={c.id}
                  onClick={() => handleSelectCourse(c.id)}
                  style={featuredCardStyle}
                  className="featured-card"
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", width: "100%" }}>
                    <div style={{ flex: 1, minWidth: 0, paddingRight: 4 }}>
                      <div style={featuredCardTitleStyle}>{displayName}</div>
                      <div style={featuredCardSubtitleStyle}>{c.name}</div>
                    </div>
                    <span style={badgeStyle}>Featured</span>
                  </div>
                  <div style={featuredCardFooterStyle}>
                    <span>18 Holes</span>
                    <span style={arrowStyle}>→</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* All Courses / Other Courses List */}
      {others.length > 0 && (
        <div>
          <h2 style={sectionHeaderStyle}>All Courses</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {others.map((c) => (
              <div
                key={c.id}
                onClick={() => handleSelectCourse(c.id)}
                style={listCardStyle}
                className="list-card"
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                  <div style={listCardIconStyle}>⛳</div>
                  <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                    <span style={listCardTitleStyle}>{c.name}</span>
                    {c.lastSelectedAt && (
                      <span style={listCardSubtitleStyle}>
                        Played {new Date(c.lastSelectedAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' })}
                      </span>
                    )}
                  </div>
                </div>
                <span style={listCardArrowStyle}>→</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p style={{ marginTop: 32, opacity: 0.6, fontSize: 12, textAlign: "center", borderTop: "1px solid #1c2620", paddingTop: 16 }}>
        <Link to="/round/demo" style={{ color: "#10b981", textDecoration: "none", fontWeight: 600 }}>
          Preview demo round map view
        </Link>
        <span style={{ margin: "0 8px", opacity: 0.3 }}>|</span>
        <Link to="/imports" style={{ color: "#10b981", textDecoration: "none", fontWeight: 600 }}>
          Import Overpass GeoJSON
        </Link>
      </p>
    </div>
  );
}

// Styling definitions for CSS-in-JS (keeps index.css light and React fully dynamic)
const searchInputStyle: React.CSSProperties = {
  width: "100%",
  background: "#121914",
  border: "1px solid #203628",
  borderRadius: 12,
  color: "#eef2ef",
  fontSize: 14,
  padding: "10px 16px 10px 36px",
  outline: "none",
  fontWeight: 500,
  transition: "border-color 0.2s"
};

const searchIconStyle: React.CSSProperties = {
  position: "absolute",
  left: 12,
  top: 10,
  fontSize: 14,
  opacity: 0.5,
  pointerEvents: "none"
};

const clearButtonStyle: React.CSSProperties = {
  position: "absolute",
  right: 12,
  top: 6,
  background: "none",
  border: "none",
  color: "#8fa395",
  fontSize: 18,
  cursor: "pointer",
  padding: 4
};

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  color: "#6c8574",
  marginBottom: 10,
  fontWeight: 800
};

const featuredGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 12
};

const featuredCardStyle: React.CSSProperties = {
  background: "linear-gradient(135deg, #16301e 0%, #0d1f14 100%)",
  border: "1px solid #2f5c3d",
  borderRadius: 16,
  padding: 16,
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-between",
  minHeight: 116,
  cursor: "pointer",
  color: "#eef2ef",
  boxShadow: "0 4px 16px rgba(0, 0, 0, 0.4)",
  userSelect: "none"
};

const featuredCardTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  lineHeight: 1.2,
  color: "#ffffff",
  marginBottom: 2,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap"
};

const featuredCardSubtitleStyle: React.CSSProperties = {
  fontSize: 9,
  color: "#8fa395",
  fontWeight: 500,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap"
};

const badgeStyle: React.CSSProperties = {
  fontSize: 8,
  fontWeight: 800,
  textTransform: "uppercase",
  padding: "2px 6px",
  borderRadius: 4,
  background: "rgba(16, 185, 129, 0.15)",
  color: "#10b981",
  border: "1px solid rgba(16, 185, 129, 0.25)",
  whiteSpace: "nowrap"
};

const featuredCardFooterStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  width: "100%",
  fontSize: 10,
  fontWeight: 600,
  color: "#6c8574",
  marginTop: 12
};

const arrowStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#10b981",
  fontWeight: 700
};

const listCardStyle: React.CSSProperties = {
  background: "#111813",
  border: "1px solid #1c2c20",
  borderRadius: 12,
  padding: "12px 16px",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  cursor: "pointer",
  color: "#eef2ef",
  boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
  userSelect: "none"
};

const listCardIconStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 8,
  background: "#0c110d",
  border: "1px solid #1c2620",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 12
};

const listCardTitleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#ffffff"
};

const listCardSubtitleStyle: React.CSSProperties = {
  fontSize: 9,
  color: "#6c8574",
  fontWeight: 500,
  marginTop: 2
};

const listCardArrowStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#6c8574",
  fontWeight: 700
};

const emptyStateStyle: React.CSSProperties = {
  textAlign: "center",
  padding: "40px 20px",
  background: "#111813",
  border: "1px dashed #203628",
  borderRadius: 16,
  color: "#eef2ef"
};
