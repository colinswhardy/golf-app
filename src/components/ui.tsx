import { Link } from "react-router-dom";
import type { ReactNode } from "react";

/**
 * Shared UI primitives. Everything visual should compose from these plus the
 * classes in index.css — pages shouldn't be inventing their own button or card
 * styling. Inline styles stay reserved for genuinely dynamic values.
 */

// ---------------------------------------------------------------------------
// Icons — a small inline set (no icon dependency, works offline, inherits
// currentColor so states are handled by CSS alone).
// ---------------------------------------------------------------------------

type IconProps = { size?: number };

function svg(path: ReactNode, size = 22) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {path}
    </svg>
  );
}

export const Icon = {
  play: ({ size }: IconProps = {}) => svg(<><path d="M5 3.5v17l14-8.5-14-8.5Z" /></>, size),
  flag: ({ size }: IconProps = {}) => svg(<><path d="M5 21V4" /><path d="M5 4.5h11l-2 3.5 2 3.5H5" /></>, size),
  list: ({ size }: IconProps = {}) => svg(<><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="3.5" cy="6" r="1.2" /><circle cx="3.5" cy="12" r="1.2" /><circle cx="3.5" cy="18" r="1.2" /></>, size),
  chart: ({ size }: IconProps = {}) => svg(<><path d="M3 21h18" /><rect x="5" y="11" width="4" height="7" rx="1" /><rect x="12" y="6" width="4" height="12" rx="1" /><rect x="19" y="14" width="2" height="4" rx="1" /></>, size),
  gear: ({ size }: IconProps = {}) => svg(<><circle cx="12" cy="12" r="3.2" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" /></>, size),
  search: ({ size }: IconProps = {}) => svg(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>, size),
  close: ({ size }: IconProps = {}) => svg(<><path d="M18 6 6 18M6 6l12 12" /></>, size),
  back: ({ size }: IconProps = {}) => svg(<><path d="m15 18-6-6 6-6" /></>, size),
  chevron: ({ size }: IconProps = {}) => svg(<><path d="m9 18 6-6-6-6" /></>, size),
  pin: ({ size }: IconProps = {}) => svg(<><path d="M12 21s7-6.4 7-11a7 7 0 1 0-14 0c0 4.6 7 11 7 11Z" /><circle cx="12" cy="10" r="2.4" /></>, size),
  target: ({ size }: IconProps = {}) => svg(<><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="0.8" fill="currentColor" /></>, size),
  layers: ({ size }: IconProps = {}) => svg(<><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 13 9 5 9-5" /></>, size),
  note: ({ size }: IconProps = {}) => svg(<><path d="M5 4.5A1.5 1.5 0 0 1 6.5 3h11A1.5 1.5 0 0 1 19 4.5v15a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5Z" /><path d="M9 8h6M9 12h6M9 16h3" /></>, size),
  ellipse: ({ size }: IconProps = {}) => svg(<><ellipse cx="12" cy="12" rx="5" ry="8.5" /><path d="M12 3.5v17" /></>, size),
  watch: ({ size }: IconProps = {}) => svg(<><rect x="6.5" y="6.5" width="11" height="11" rx="3" /><path d="M9 6.5 9.5 3h5l.5 3.5M9 17.5l.5 3.5h5l.5-3.5M12 9.8V12l1.6 1.2" /></>, size),
  tag: ({ size }: IconProps = {}) => svg(<><path d="M3 12V4.5A1.5 1.5 0 0 1 4.5 3H12l8.5 8.5a2 2 0 0 1 0 2.8l-6.2 6.2a2 2 0 0 1-2.8 0Z" /><circle cx="7.5" cy="7.5" r="1.4" /></>, size),
  bolt: ({ size }: IconProps = {}) => svg(<><path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12Z" /></>, size),
  upload: ({ size }: IconProps = {}) => svg(<><path d="M12 16V4M8 8l4-4 4 4" /><path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16" /></>, size),
  download: ({ size }: IconProps = {}) => svg(<><path d="M12 4v12M8 12l4 4 4-4" /><path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16" /></>, size),
  edit: ({ size }: IconProps = {}) => svg(<><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17Z" /><path d="m14.5 6.5 3 3" /></>, size),
  warn: ({ size }: IconProps = {}) => svg(<><path d="M10.3 3.9 2.4 17.5A1.9 1.9 0 0 0 4 20.4h16a1.9 1.9 0 0 0 1.6-2.9L13.7 3.9a1.9 1.9 0 0 0-3.4 0Z" /><path d="M12 9v4.5M12 17.2v.1" /></>, size),
  check: ({ size }: IconProps = {}) => svg(<><path d="m4 12.5 5 5L20 6.5" /></>, size),
  trash: ({ size }: IconProps = {}) => svg(<><path d="M4 7h16M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7" /><path d="M6.5 7 7.5 20h9L17.5 7" /></>, size),
  plus: ({ size }: IconProps = {}) => svg(<><path d="M12 5v14M5 12h14" /></>, size),
  golfer: ({ size }: IconProps = {}) => svg(<><circle cx="14" cy="4.6" r="2" /><path d="M13 7.5 9.5 11l3 2.5-1 7M13 7.5l5 4.5M4 21h16" /></>, size)
};

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function Page({ children }: { children: ReactNode }) {
  return <div className="page">{children}</div>;
}

export function AppBar({
  title,
  subtitle,
  backTo = "/",
  onBack,
  actions
}: {
  title: string;
  subtitle?: string;
  backTo?: string;
  onBack?: () => void;
  actions?: ReactNode;
}) {
  return (
    <header className="app-bar">
      {onBack ? (
        <button className="app-bar__back" onClick={onBack} aria-label="Back">
          <Icon.back size={19} />
        </button>
      ) : (
        <Link className="app-bar__back" to={backTo} aria-label="Back">
          <Icon.back size={19} />
        </Link>
      )}
      <div className="app-bar__titles">
        <h1 className="app-bar__title">{title}</h1>
        {subtitle && <div className="app-bar__sub">{subtitle}</div>}
      </div>
      {actions}
    </header>
  );
}

export function Section({
  title,
  action,
  hint,
  children
}: {
  title?: string;
  action?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section">
      {(title || action) && (
        <div className="section__head">
          {title && <h2 className="section__title">{title}</h2>}
          {action}
        </div>
      )}
      {hint && <p className="section__hint">{hint}</p>}
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

type ButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger" | "ghost";
  size?: "sm" | "md";
  block?: boolean;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
};

export function Button({
  children,
  onClick,
  variant = "default",
  size = "md",
  block,
  disabled,
  title,
  ariaLabel
}: ButtonProps) {
  const classes = [
    "btn",
    variant !== "default" ? `btn--${variant}` : "",
    size === "sm" ? "btn--sm" : "",
    block ? "btn--block" : ""
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button className={classes} onClick={onClick} disabled={disabled} title={title} aria-label={ariaLabel}>
      {children}
    </button>
  );
}

export function Chip({
  children,
  active,
  onClick,
  small
}: {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
  small?: boolean;
}) {
  return (
    <button
      className={`chip${active ? " chip--active" : ""}${small ? " chip--sm" : ""}`}
      onClick={onClick}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

export function Badge({
  children,
  tone = "neutral"
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "warn" | "danger" | "info";
}) {
  return <span className={`badge${tone !== "neutral" ? ` badge--${tone}` : ""}`}>{children}</span>;
}

export function Note({
  children,
  tone = "neutral"
}: {
  children: ReactNode;
  tone?: "neutral" | "warn" | "danger" | "ok";
}) {
  return <div className={`note${tone !== "neutral" ? ` note--${tone}` : ""}`}>{children}</div>;
}

export function EmptyState({
  icon = "⛳",
  title,
  children
}: {
  icon?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty__icon">{icon}</div>
      <div className="empty__title">{title}</div>
      {children && <div className="empty__body">{children}</div>}
    </div>
  );
}

export function Stat({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="stat">
      <div className="stat__value">{value}</div>
      <div className="stat__label">{label}</div>
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

// ---------------------------------------------------------------------------
// Score formatting — shared so the scorecard, round bar and review list all
// agree on what "+3" looks like and which colour it carries.
// ---------------------------------------------------------------------------

export function relativeToParLabel(diff: number): string {
  return diff === 0 ? "E" : diff > 0 ? `+${diff}` : `${diff}`;
}

export function scoreToneClass(score: number, par: number): string {
  const d = score - par;
  if (d < 0) return "score-dot score-dot--under";
  if (d === 0) return "score-dot score-dot--par";
  if (d === 1) return "score-dot score-dot--over";
  return "score-dot score-dot--blowup";
}
