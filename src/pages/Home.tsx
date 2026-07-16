import { Link } from "react-router-dom";

const TILES: { label: string; to: string | null }[] = [
  { label: "Courses", to: "/courses" },
  { label: "Review Rounds", to: "/rounds" },
  { label: "Data Imports", to: "/imports" },
  { label: "", to: null },
  { label: "", to: null },
  { label: "Settings", to: "/settings" }
];

export function Home() {
  return (
    <div style={{ padding: 16, height: "100%" }}>
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>Golf</h1>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {TILES.map((tile, i) =>
          tile.to ? (
            <Link
              key={i}
              to={tile.to}
              style={{ ...tileStyle, textDecoration: "none" }}
            >
              {tile.label}
            </Link>
          ) : (
            <div key={i} style={{ ...tileStyle, opacity: 0.3 }} />
          )
        )}
      </div>
    </div>
  );
}

const tileStyle: React.CSSProperties = {
  aspectRatio: "1",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#132a1a",
  border: "1px solid #2f5c3d",
  borderRadius: 12,
  color: "#eef2ef",
  fontSize: 16,
  textAlign: "center",
  padding: 12
};
