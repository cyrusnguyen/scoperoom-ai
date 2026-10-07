import type { SourceHead, SourceVersionView } from "../contracts/source-version.ts";

type Head = Pick<SourceHead, "version" | "currentVersionId">;
type View = Pick<SourceVersionView, "id" | "sequence" | "title" | "text">;
/** The exact inspected content and guards are retained with both local fields until explicit review or discard. */
export type SourceCorrection = { base: View & { recordVersion: number }; title: string; text: string };

const changed = (draft: SourceCorrection) => draft.title !== draft.base.title || draft.text !== draft.base.text ? draft : undefined;
const baseline = (head: Head, view: View) => ({ id: view.id, sequence: view.sequence, title: view.title, text: view.text, recordVersion: head.version });

export function editSourceCorrection(current: SourceCorrection | undefined, head: Head, view: View, field: "title" | "text", value: string): SourceCorrection | undefined {
  if (!current && view.id !== head.currentVersionId) return undefined;
  const draft = current ?? { base: baseline(head, view), title: view.title, text: view.text };
  return changed({ ...draft, [field]: value });
}

/** Called only after the person reviews this current saved version. Unedited fields adopt its latest content. */
export function reconcileSourceCorrection(current: SourceCorrection, head: Head, view: View): SourceCorrection | undefined {
  if (view.id !== head.currentVersionId) return current;
  return changed({ base: baseline(head, view),
    title: current.title === current.base.title ? view.title : current.title,
    text: current.text === current.base.text ? view.text : current.text });
}

export const sourceCorrectionBody = (draft: SourceCorrection) => ({
  expectedSourceRecordVersion: draft.base.recordVersion, expectedCurrentVersionId: draft.base.id, title: draft.title.trim(), text: draft.text,
});
