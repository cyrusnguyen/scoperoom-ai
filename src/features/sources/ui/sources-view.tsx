"use client";

import type { SpecsUi } from "@/features/shell/ui/project-ui";

// Placeholder: the next task replaces this with the Sources view.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function SourcesView(props: {
  ui: SpecsUi; update: (change: (ui: SpecsUi) => Partial<SpecsUi>) => void; drafts: Record<string, string>; setDraft: (key: string, value: string | undefined) => void;
}) {
  return <p>Loading…</p>;
}
