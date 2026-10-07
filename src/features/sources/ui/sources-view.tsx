"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { apiMutate, apiRead, sessionEnded } from "@/client/api";
import { useSync } from "@/features/collaboration/ui/sync-context";
import type { SpecsRequest, SpecsUi } from "@/features/shell/ui/project-ui";
import { useStudio } from "@/features/studio/ui/studio-context";
import {
  normalizeEvidence, SOURCE_BODY_LIMIT, SOURCE_LIMITS, SOURCE_TITLE_LIMIT, USER_DOCUMENT_LIMIT, USER_SOURCE_KINDS,
  type SourceHead, type SourcePage, type SourceScope, type SourceVersionPage, type SourceVersionView, type SourceWriteResult,
} from "../contracts/source-version";

const KIND_LABELS: Record<SourceHead["kind"], string> = { USER_TEXT: "Pasted", USER_UPLOAD: "Uploaded", PROMOTED_GRAPH: "Saved flow", QUESTION_ANSWER: "Answer", AI_PROMPT: "AI instruction" };
const SCOPES: Array<[SourceScope, string]> = [["user", "Active"], ["archived", "Archived"], ["internal", "Internal"]];
const EMPTY: Record<SourceScope, string> = { user: "No active sources", archived: "No archived sources", internal: "No internal evidence yet" };
const LIMIT_TEXT: Record<string, string> = {
  SOURCE_SUBMISSION: `A source can hold at most ${SOURCE_LIMITS.submissionCodePoints.toLocaleString("en-US")} characters.`,
  SOURCE_BODY_BYTES: "This source is too large to send.",
  SOURCE_DOCUMENTS: `The project already has ${USER_DOCUMENT_LIMIT} active documents. Archive one first.`,
  SOURCE_VERSIONS: `The project has reached ${SOURCE_LIMITS.retainedVersions} retained versions.`,
  SOURCE_CODE_POINTS: `The project has reached ${SOURCE_LIMITS.projectCodePoints.toLocaleString("en-US")} characters of source text.`,
};
const NEW_TITLE = "specs:new-source:title", NEW_TEXT = "specs:new-source:text";
const codePoints = (value: string) => [...normalizeEvidence(value)].length;
const isUser = (head: SourceHead) => USER_SOURCE_KINDS.includes(head.kind);

/** Source heads for one scope, reloaded whenever the project's sources cursor moves (and when the scope or `retry` changes). */
export function useSourceList(projectId: string, scope: SourceScope, revision: number) {
  const [loaded, setLoaded] = useState<{ scope: SourceScope; page: SourcePage } | null>(null);
  const [failed, setFailed] = useState<{ scope: SourceScope; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void apiRead<SourcePage>(`/api/projects/${projectId}/sources?scope=${scope}`, controller.signal).then((result) => {
      if (controller.signal.aborted || sessionEnded(result)) return;
      if (result.ok) { setLoaded({ scope, page: result.data }); setFailed(null); } else setFailed({ scope, message: result.message });
    });
    return () => controller.abort();
  }, [projectId, scope, revision, attempt]);
  const more = () => {
    const cursor = loaded?.page.nextCursor;
    if (loaded?.scope !== scope || !cursor) return;
    void apiRead<SourcePage>(`/api/projects/${projectId}/sources?scope=${scope}&cursor=${cursor}`).then((result) => {
      if (result.ok) setLoaded((current) => current && current.scope === scope ? { scope, page: { ...result.data, items: [...current.page.items, ...result.data.items] } } : current);
      else if (!sessionEnded(result)) setFailed({ scope, message: result.message });
    });
  };
  // A page or error from another scope is never shown under this one's filter.
  return { page: loaded?.scope === scope ? loaded.page : null, error: failed?.scope === scope ? failed.message : "", more, retry: () => setAttempt((count) => count + 1) };
}

/** Reads a file as strict UTF-8; null means it is not valid UTF-8 text. */
async function readUtf8(file: File): Promise<string | null> {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); } catch { return null; }
}

type Update = (change: (ui: SpecsUi) => Partial<SpecsUi>) => void;
type Notice = { text: string; kind: "status" | "alert" };
type Post = (path: string, body: Record<string, unknown>, method: "POST" | "PATCH", label: string) => void;
type Shared = { busy: boolean; post: Post; setDraft: (key: string, value: string | undefined) => void; drafts: Record<string, string> };
const FLOW_TITLE = "specs:flow-source:title";
const correctKey = (id: string, field: "title" | "text") => `specs:correct:${id}:${field}`;

export default function SourcesView({ ui, update, drafts, setDraft }: {
  ui: SpecsUi; update: Update; drafts: Record<string, string>; setDraft: (key: string, value: string | undefined) => void;
}) {
  const { status, beforeWrite, revalidate } = useSync();
  const { projectId, savedDraft } = useStudio();
  const scope = ui.sourceScope;
  const list = useSourceList(projectId, scope, status.sourcesRevision);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [refocus, setRefocus] = useState(0);
  // Heads patched by this session's own writes, so the reader is right before the list is read again (the higher record version wins).
  const [kept, setKept] = useState<SourceHead | null>(null);
  const canEdit = status.status === "ACTIVE" && (status.role === "OWNER" || status.role === "EDITOR");
  const selected = ui.selected?.kind === "source" ? ui.selected : null;
  const listed = selected ? list.page?.items.find((item) => item.id === selected.sourceId) : undefined;
  const patched = kept && kept.id === selected?.sourceId ? kept : undefined;
  const head = listed && patched ? (patched.version > listed.version ? patched : listed) : listed ?? patched ?? null;
  const headRef = useRef(head);
  useEffect(() => { headRef.current = head; });
  // Back unmounts the focused button: the card of the source that was open takes focus once the list is on screen. If a refresh
  // removes that card (it was archived) the active filter takes it; anything else the person focused meanwhile is left alone.
  const returnTo = useRef<string | null>(null);
  useEffect(() => {
    if (!returnTo.current || selected || !list.page) return;
    const card = document.querySelector<HTMLElement>(`[data-source-id="${returnTo.current}"]`);
    const active = document.activeElement;
    if (active && active !== document.body && active !== card) { returnTo.current = null; return; }
    (card ?? document.querySelector<HTMLElement>('.sources-filter [aria-pressed="true"]'))?.focus();
    if (!card) returnTo.current = null;
  }, [selected, list.page]);

  /** What a committed write changes locally, derived from the request so a Retry after a remount does the same. Returns the message. */
  function finish(request: SpecsRequest, result: SourceWriteResult): string {
    const [, , id] = request.path.split("/");
    if (request.path === "/sources") { setDraft(NEW_TITLE, undefined); setDraft(NEW_TEXT, undefined); return "Source added."; }
    if (request.path.endsWith("/graph-sources")) { setDraft(FLOW_TITLE, undefined); return "Saved flow added as a source."; }
    const known = headRef.current?.id === id ? headRef.current : null;
    setRefocus((count) => count + 1);
    if (request.path.endsWith("/versions")) {
      setDraft(correctKey(id!, "title"), undefined); setDraft(correctKey(id!, "text"), undefined);
      if (known) setKept({ ...known, title: String(request.body.title), version: result.version, currentVersionId: result.sourceVersionId, currentSequence: result.sequence, versionCount: known.versionCount + 1 });
      update((current) => current.selected?.kind === "source" && current.selected.sourceId === id ? { selected: { ...current.selected, versionId: null } } : {});
      return "New version saved.";
    }
    const archived = request.body.archived === true;
    if (known) setKept({ ...known, archived, version: result.version });
    return archived ? "Source archived." : "Source restored.";
  }
  async function send(request: SpecsRequest, retry: boolean) {
    setBusy(true); setNotice(null);
    // Kept before anything is awaited: a switch of tab or panel mid-flight must still find the exact key to retry.
    if (!retry) update(() => ({ pending: request }));
    const fail = (text: string) => { setBusy(false); if (!retry) update(() => ({ pending: null })); setNotice({ text, kind: "alert" }); };
    const authority = await beforeWrite();
    if (authority.kind === "unavailable") return fail("Not saved. We couldn’t reach ScopeRoom.");
    if (authority.kind === "denied") return fail("Checking your access…");
    if (!retry && (authority.status.status !== "ACTIVE" || (authority.status.role !== "OWNER" && authority.status.role !== "EDITOR"))) return fail("Not saved. This project is read-only now.");
    const result = await apiMutate<SourceWriteResult>(`/api/projects/${projectId}${request.path}`, request.key, request.body, request.method ?? "POST");
    setBusy(false);
    if (sessionEnded(result)) return;
    if (result.ok) {
      update(() => ({ pending: null }));
      setNotice({ text: finish(request, result.data), kind: "status" });
      void revalidate("manual");
    } else if (!result.uncertain) {
      update(() => ({ pending: null }));
      setNotice({ text: result.code === "LIMIT_EXCEEDED" ? LIMIT_TEXT[String(result.details?.limit)] ?? result.message : result.message, kind: "alert" });
      if (result.status === 409) void revalidate("manual"); // someone else saved first: read the current heads
    }
    // An uncertain result leaves `pending` as it is; the Retry below is derived from it.
  }
  const post: Post = (path, body, method, label) => void send({ key: crypto.randomUUID(), path, body, method, label }, false);
  const shared: Shared = { busy: busy || ui.pending !== null, post, setDraft, drafts };
  const usage = list.page?.usage;

  return <div className="sources-view">
    {usage && <p className="muted">{usage.activeUserDocuments}/{USER_DOCUMENT_LIMIT} documents · {usage.retainedVersions}/{SOURCE_LIMITS.retainedVersions} versions · {usage.codePoints.toLocaleString("en-US")}/{SOURCE_LIMITS.projectCodePoints.toLocaleString("en-US")} characters</p>}
    {notice && <p role={notice.kind === "alert" ? "alert" : "status"}>{notice.text}</p>}
    {ui.pending && !busy && <p role="alert">We couldn’t confirm “{ui.pending.label}”. Retry sends the same request. <button type="button" className="button small" onClick={() => void send(ui.pending!, true)}>Retry</button></p>}
    {selected ? <Reader selected={selected} head={head} listLoaded={list.page !== null} canEdit={canEdit} update={update} refocus={refocus} onBack={(id) => { returnTo.current = id; }} {...shared} />
      : <>
        {canEdit && <AddSource {...shared} />}
        {canEdit && <FlowSource flows={savedDraft.document.flows} draftId={savedDraft.id} documentRevision={savedDraft.documentRevision} {...shared} />}
        <div role="group" aria-label="Source filter" className="sources-filter">
          {SCOPES.map(([id, label]) => <button key={id} type="button" className="button small" aria-pressed={scope === id} onClick={() => update(() => ({ sourceScope: id }))}>{label}</button>)}
        </div>
        {list.error && <p role="alert">{list.error} <button type="button" className="button small" onClick={list.retry}>Retry</button></p>}
        {!list.page ? !list.error && <p role="status">Loading sources…</p>
          : !list.page.items.length ? <p className="muted">{EMPTY[scope]}</p>
          : <ul className="sources-list">{list.page.items.map((item) => <li key={item.id}>
            <button type="button" className="specs-card" data-source-id={item.id} onClick={() => { setRefocus((count) => count + 1); update(() => ({ selected: { kind: "source", sourceId: item.id, versionId: null, back: ui.selected } })); }}>
              <strong>{item.displayNickname ?? item.title}</strong>
              <span className="specs-badge">{KIND_LABELS[item.kind]} · v{item.currentSequence} · {item.versionCount} {item.versionCount === 1 ? "version" : "versions"}{item.archived ? " · Archived" : ""}</span>
            </button></li>)}
          </ul>}
        {list.page?.nextCursor && <button type="button" className="button small" onClick={list.more}>Load more</button>}
      </>}
  </div>;
}

function AddSource({ busy, post, drafts, setDraft }: Shared) {
  const title = drafts[NEW_TITLE] ?? "", text = drafts[NEW_TEXT] ?? "";
  const [fileError, setFileError] = useState("");
  // The text a file supplied: it is sent as an upload only while the textarea still holds exactly that.
  const [uploadedText, setUploadedText] = useState<string | null>(null);
  const uploaded = uploadedText === text;
  const count = codePoints(text);
  const set = (key: string, value: string) => setDraft(key, value || undefined);
  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target, file = input.files?.[0];
    if (!file) return;
    const tooLarge = file.size > SOURCE_BODY_LIMIT;
    const decoded = tooLarge ? null : await readUtf8(file);
    input.value = "";
    if (decoded === null) { setFileError(tooLarge ? "This file is too large to add as a source." : "This file isn't valid UTF-8 text."); return; }
    setFileError(""); setUploadedText(decoded);
    set(NEW_TEXT, decoded);
    if (!title) set(NEW_TITLE, [...file.name].slice(0, SOURCE_TITLE_LIMIT).join(""));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    post("/sources", { title: title.trim(), text, ...(uploaded ? { uploaded: true } : {}) }, "POST", "Add source");
  };
  return <form className="detail-section" onSubmit={submit}>
    <h3>Add a source</h3>
    <div className="field"><label htmlFor="new-source-title">Source title</label><input id="new-source-title" value={title} readOnly={busy} maxLength={SOURCE_TITLE_LIMIT} onChange={(event) => set(NEW_TITLE, event.target.value)} /></div>
    <div className="field"><label htmlFor="new-source-text">Source text</label><textarea id="new-source-text" rows={6} value={text} readOnly={busy} onChange={(event) => set(NEW_TEXT, event.target.value)} /></div>
    <div className="field"><label htmlFor="new-source-file">Upload .txt or .md</label><input id="new-source-file" type="file" disabled={busy} accept=".txt,.md,text/plain,text/markdown" onChange={(event) => void choose(event)} /></div>
    {fileError && <p role="alert">{fileError}</p>}
    <p className="muted" data-over={count > SOURCE_LIMITS.submissionCodePoints}>{count.toLocaleString("en-US")}/{SOURCE_LIMITS.submissionCodePoints.toLocaleString("en-US")} characters</p>
    <button type="submit" className="button primary" disabled={busy || !title.trim() || !text.trim() || count > SOURCE_LIMITS.submissionCodePoints}>Add source</button>
  </form>;
}

function FlowSource({ flows, draftId, documentRevision, busy, post, drafts, setDraft }: Shared & { flows: Record<string, { title: string }>; draftId: string; documentRevision: number }) {
  const [flowId, setFlowId] = useState("");
  const name = drafts[FLOW_TITLE] ?? "";
  const setName = (value: string) => setDraft(FLOW_TITLE, value || undefined);
  const ids = Object.keys(flows);
  const chosen = flows[flowId] ? flowId : ids[0] ?? "";
  const title = name || flows[chosen]?.title || "";
  if (!ids.length) return null;
  return <form className="detail-section" onSubmit={(event) => {
    event.preventDefault();
    post(`/drafts/${draftId}/graph-sources`, { expectedDocumentRevision: documentRevision, flowId: chosen, title: title.trim() }, "POST", "Add flow as source");
  }}>
    <h3>From saved flow</h3>
    <div className="field"><label htmlFor="flow-source-flow">Flow</label><select id="flow-source-flow" value={chosen} disabled={busy} onChange={(event) => { setFlowId(event.target.value); setName(""); }}>{ids.map((id) => <option key={id} value={id}>{flows[id]!.title}</option>)}</select></div>
    <div className="field"><label htmlFor="flow-source-title">Flow source title</label><input id="flow-source-title" value={title} readOnly={busy} maxLength={SOURCE_TITLE_LIMIT} onChange={(event) => setName(event.target.value)} /></div>
    <p className="muted">Uses the last saved version of the flow.</p>
    <button type="submit" className="button" disabled={busy || !title.trim()}>Add flow as source</button>
  </form>;
}

function Reader({ selected, head, listLoaded, canEdit, update, refocus, onBack, busy, post, drafts, setDraft }: Shared & {
  selected: NonNullable<Extract<SpecsUi["selected"], { kind: "source" }>>; head: SourceHead | null; listLoaded: boolean; canEdit: boolean; update: Update; refocus: number; onBack: (sourceId: string) => void;
}) {
  const { projectId } = useStudio();
  const viewId = selected.versionId ?? head?.currentVersionId ?? null;
  const [read, setRead] = useState<{ id: string; view?: SourceVersionView; error?: string } | null>(null);
  const [versions, setVersions] = useState<{ key: string; page: SourceVersionPage } | null>(null);
  const versionsKey = head ? `${head.id}:${head.currentVersionId}` : "";
  useEffect(() => {
    if (!viewId) return;
    const controller = new AbortController();
    void apiRead<SourceVersionView>(`/api/projects/${projectId}/source-versions/${viewId}`, controller.signal).then((result) => {
      if (controller.signal.aborted || sessionEnded(result)) return;
      setRead(result.ok ? { id: viewId, view: result.data } : { id: viewId, error: result.message });
    });
    return () => controller.abort();
  }, [projectId, viewId]);
  useEffect(() => {
    if (!head) return;
    const controller = new AbortController();
    void apiRead<SourceVersionPage>(`/api/projects/${projectId}/sources/${head.id}/versions`, controller.signal).then((result) => {
      if (!controller.signal.aborted && !sessionEnded(result) && result.ok) setVersions({ key: versionsKey, page: result.data });
    });
    return () => controller.abort();
    // The head's id and current version are what the list depends on; the head object itself changes more often.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, versionsKey]);
  const moreVersions = () => {
    const cursor = versions?.page.nextCursor;
    if (!head || !cursor) return;
    void apiRead<SourceVersionPage>(`/api/projects/${projectId}/sources/${head.id}/versions?cursor=${cursor}`).then((result) => {
      if (result.ok) setVersions((current) => current && { key: current.key, page: { ...result.data, items: [...current.page.items, ...result.data.items] } });
    });
  };

  const current = read?.id === viewId ? read : null;
  const view = current?.view;
  // After the person opens a source or commits a correction, archive or restore, focus moves to the heading once the (new) version is on screen.
  const heading = useRef<HTMLHeadingElement>(null), focused = useRef(0);
  useEffect(() => {
    if (view && refocus !== focused.current) { focused.current = refocus; heading.current?.focus(); }
  }, [refocus, view]);
  const goBack = () => { onBack(selected.sourceId); update(() => ({ selected: selected.back })); };
  const back = <button type="button" className="button quiet small" onClick={goBack}>Back</button>;
  if (!head) return <>{back}<p role={listLoaded ? "alert" : "status"}>{listLoaded ? "This source isn't in the loaded list." : "Loading source…"}</p></>;

  const editable = canEdit && isUser(head);
  const atHead = view?.id === head.currentVersionId;
  const titleKey = correctKey(head.id, "title"), textKey = correctKey(head.id, "text");
  const title = drafts[titleKey] ?? view?.title ?? "", text = drafts[textKey] ?? view?.text ?? "";
  const count = codePoints(text);
  const changed = view !== undefined && (title !== view.title || text !== view.text);
  const edit = (key: string, base: string | undefined, value: string) => setDraft(key, value === base ? undefined : value);
  const correct = (event: FormEvent) => {
    event.preventDefault();
    post(`/sources/${head.id}/versions`, { expectedSourceRecordVersion: head.version, expectedCurrentVersionId: head.currentVersionId, title: title.trim(), text }, "POST", "Save new version");
  };
  const archive = () => post(`/sources/${head.id}`, { expectedSourceRecordVersion: head.version, archived: !head.archived }, "PATCH", head.archived ? "Restore source" : "Archive source");

  return <div className="source-reader">
    {back}
    <h3 ref={heading} tabIndex={-1}>{head.displayNickname ?? view?.title ?? head.title}</h3>
    <p className="muted">{KIND_LABELS[head.kind]}{head.archived ? " · Archived" : ""}</p>
    {current?.error ? <p role="alert">{current.error}</p> : !view ? <p role="status">Loading version…</p> : <>
      <div className="sources-filter">
        <p className="muted">Viewing v{view.sequence}; latest v{head.currentSequence}</p>
        {!atHead && <button type="button" className="button small" onClick={() => update(() => ({ selected: { ...selected, versionId: null } }))}>Latest</button>}
      </div>
      <ol className="source-lines" aria-label="Source lines">{view.text.split("\n").map((line, index) => <li key={index}>{line}</li>)}</ol>
    </>}
    {versions?.key === versionsKey && <section aria-label="Versions">
      <h3>Versions</h3>
      <ul className="sources-list">{versions.page.items.map((item) => <li key={item.id}>
        <button type="button" className="button quiet small" aria-pressed={item.id === viewId} onClick={() => update(() => ({ selected: { ...selected, versionId: item.id } }))}>v{item.sequence}</button>{" "}
        <span className="muted">{item.codePointCount.toLocaleString("en-US")} characters</span>
      </li>)}</ul>
      {versions.page.nextCursor && <button type="button" className="button small" onClick={moreVersions}>Load more versions</button>}
    </section>}
    {editable && !head.archived && view && (atHead
      ? <form className="detail-section" onSubmit={correct}>
        <h3>Correct this source</h3>
        <div className="field"><label htmlFor="corrected-title">Corrected title</label><input id="corrected-title" value={title} readOnly={busy} maxLength={SOURCE_TITLE_LIMIT} onChange={(event) => edit(titleKey, view.title, event.target.value)} /></div>
        <div className="field"><label htmlFor="corrected-text">Corrected text</label><textarea id="corrected-text" rows={8} value={text} readOnly={busy} onChange={(event) => edit(textKey, view.text, event.target.value)} /></div>
        <p className="muted">{count.toLocaleString("en-US")}/{SOURCE_LIMITS.submissionCodePoints.toLocaleString("en-US")} characters</p>
        <button type="submit" className="button primary" disabled={busy || !changed || !title.trim() || !text.trim() || count > SOURCE_LIMITS.submissionCodePoints}>Save new version</button>
      </form>
      : <p className="muted">Open the latest version to correct it.</p>)}
    {editable && <button type="button" className="button" disabled={busy} onClick={archive}>{head.archived ? "Restore" : "Archive"}</button>}
  </div>;
}
