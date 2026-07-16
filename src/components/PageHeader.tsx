import { Link } from "react-router-dom";

export function PageHeader({ title }: { title: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
      <Link to="/" style={{ textDecoration: "none", fontSize: 18 }}>
        ←
      </Link>
      <h1 style={{ fontSize: 18, margin: 0 }}>{title}</h1>
    </div>
  );
}
