import { PageHeader } from "../components/PageHeader";

export function SettingsPage() {
  return (
    <div style={{ padding: 16 }}>
      <PageHeader title="Settings" />
      <p style={{ opacity: 0.8 }}>
        Not built yet. All global config lands here: units, default aim-point rule, strokes-gained
        baseline default (scratch vs. self-relative), Supabase sync status.
      </p>
    </div>
  );
}
