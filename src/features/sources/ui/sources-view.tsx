"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { apiRead, sessionEnded } from "@/client/api";
import { useSync } from "@/features/collaboration/ui/sync-context";
import type { useSpecsWrite } from "@/features/scope/ui/use-specs-write";
import { Icon } from "@/features/shell/ui/icon";
import type { SpecsRequest, SpecsUi } from "@/features/shell/ui/project-ui";
import { useStudio } from "@/features/studio/ui/studio-context";
import {
  normalizeEvidence, SOURCE_BODY_LIMIT, SOURCE_LIMITS, SOURCE_TITLE_LIMIT, USER_DOCUMENT_LIMIT, USER_SOURCE_KINDS,
  type SourceHead, type SourcePage, type SourceScope, type SourceVersionPage, type SourceVersionView, type SourceWriteResult,
} from "../contracts/source-version";
import { acceptFirstPage, appendSourcePage, appendVersionPage, canLoadMore, listKey, type SourceList, type VersionList } from "./source-pages";
import { editSourceCorrection, reconcileSourceCorrection, sourceCorrectionBody, type SourceCorrection } from "./source-correction";
import SourceLines from "./source-lines";
import { SOURCE_KIND_LABELS } from "./source-labels";

const SCOPES: Array<[SourceScope, string]> = [["user", "Active"], ["archived", "Archived"], ["internal", "Internal"]];
const EMPTY: Record<SourceScope, string> = { user: "No active sources", archived: "No archived sources", internal: "No internal evidence yet" };
const NEW_TITLE = "specs:new-source:title", NEW_TEXT = "specs:new-source:text", NEW_UPLOAD_NAME = "specs:new-source:upload-name";
const codePoints = (value: string) => [...normalizeEvidence(value)].length;
const isUser = (head: SourceHead) => USER_SOURCE_KINDS.includes(head.kind);

/** Source heads for one scope, reloaded whenever the project's sources cursor moves (and when the scope or `retry` changes). */
export function useSourceList(projectId: string, scope: SourceScope, revision: number) {
  const key = listKey(projectId, scope);
  const [list, setList] = useState<SourceList>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const loadingMore = useRef(false);
  const pageLifetime = useRef<AbortController | null>(null);
  // Every first-page load (a new project, filter, revision or retry) gets a ticket; only the list that load produced can be paged further.
  // Keep the last page for same-filter refreshes and project-wide usage.
  const load = `${key}:${revision}:${attempt}`;
  const [started, setStarted] = useState({ load, ticket: 1 });
  if (started.load !== load) setStarted({ load, ticket: started.ticket + 1 });
  const { ticket } = started;
  useEffect(() => {
    const controller = new AbortController();
    pageLifetime.current = controller;
    void apiRead<SourcePage>(`/api/projects/${projectId}/sources?scope=${scope}`, controller.signal).then((result) => {
      if (controller.signal.aborted || sessionEnded(result)) return;
      if (result.ok) { setList(acceptFirstPage(key, ticket, result.data)); setFailed(null); } else setFailed({ key, message: result.message });
    });
    return () => { controller.abort(); loadingMore.current = false; };
  }, [projectId, scope, revision, attempt, key, ticket]);
  const more = () => {
    const cursor = list?.page.nextCursor;
    if (!cursor || !canLoadMore(list, key, ticket) || loadingMore.current) return;
    loadingMore.current = true;
    const controller = pageLifetime.current;
    if (!controller || controller.signal.aborted) { loadingMore.current = false; return; }
    void apiRead<SourcePage>(`/api/projects/${projectId}/sources?scope=${scope}&cursor=${cursor}`, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      loadingMore.current = false;
      if (result.ok) setList((current) => appendSourcePage(current, key, ticket, cursor, result.data));
      else if (!sessionEnded(result)) setFailed({ key, message: result.message });
    });
  };
  // Only a matching page is current.
  return { page: list?.key === key ? list.page : null, retainedPage: list?.key.startsWith(`${projectId}:`) ? list.page : null, error: failed?.key === key ? failed.message : "", more, canLoadMore: canLoadMore(list, key, ticket), retry: () => setAttempt((count) => count + 1) };
}

/** Reads a file as strict UTF-8 and keeps a leading BOM, so the server normalizes uploads and pastes identically. */
async function readUtf8(file: File): Promise<string | null> {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()); } catch { return null; }
}

type Update = (change: (ui: SpecsUi) => Partial<SpecsUi>) => void;
type Write = ReturnType<typeof useSpecsWrite>;
type Post = (method: "POST" | "PATCH", path: string, body: Record<string, unknown>, label: string) => void;
type Shared = { busy: boolean; post: Post; setDraft: (key: string, value: string | undefined) => void; drafts: Record<string, string> };
const FLOW_TITLE = "specs:flow-source:title";

export default function SourcesView({ ui, update, drafts, setDraft, write, saved }: {
  ui: SpecsUi; update: Update; drafts: Record<string, string>; setDraft: (key: string, value: string | undefined) => void; write: Write;
  /** The last committed write of this panel, for what only this view shows (the patched head, focus). */
  saved: { request: SpecsRequest; data: unknown } | null;
}) {
  const { status } = useSync();
  const { projectId, savedDraft } = useStudio();
  const scope = ui.sourceScope;
  const list = useSourceList(projectId, scope, status.sourcesRevision);
  const page = list.page;
  const results = useRef<HTMLDivElement>(null);
  const [resultsMinHeight, setResultsMinHeight] = useState(0);
  const [refocus, setRefocus] = useState(0);
  // Heads patched by this session's own writes, so the reader is right before the list is read again (the higher record version wins).
  const [kept, setKept] = useState<SourceHead | null>(null);
  const canEdit = status.status === "ACTIVE" && (status.role === "OWNER" || status.role === "EDITOR");
  const selected = ui.selected?.kind === "source" ? ui.selected : null;
  const selectedId = selected?.sourceId;
  const [headRead, setHeadRead] = useState<{ id: string; head?: SourceHead; error?: string } | null>(null);
  const [headAttempt, setHeadAttempt] = useState(0);
  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    void apiRead<SourceHead>(`/api/projects/${projectId}/sources/${selectedId}`, controller.signal).then((result) => {
      if (controller.signal.aborted || sessionEnded(result)) return;
      setHeadRead(result.ok ? { id: selectedId, head: result.data } : { id: selectedId, error: result.message });
    });
    return () => controller.abort();
  }, [projectId, selectedId, status.sourcesRevision, saved, headAttempt]);
  const listed = selected ? page?.items.find((item) => item.id === selected.sourceId) : undefined;
  const patched = kept && kept.id === selected?.sourceId ? kept : undefined;
  const exact = headRead?.id === selectedId ? headRead : null;
  const head = [listed, patched, exact?.head].reduce<SourceHead | null>((latest, item) => item && (!latest || item.version > latest.version) ? item : latest, null);
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

  // A committed correction, archive or restore: patch the head until the list is read again, and move focus to the reader heading.
  const [handled, setHandled] = useState(saved);
  if (saved !== handled) {
    setHandled(saved);
    const request = saved?.request, body = request?.body, result = saved?.data as SourceWriteResult;
    if (request && body && request.path.startsWith("sources/")) {
      setRefocus((count) => count + 1);
      if (head && head.id === request.path.split("/")[1] && result.version > head.version) setKept(request.path.endsWith("/versions")
        ? { ...head, title: String(body.title), version: result.version, currentVersionId: result.sourceVersionId, currentSequence: result.sequence, versionCount: head.versionCount + 1 }
        : { ...head, archived: body.archived === true, version: result.version });
    }
  }
  const post: Post = (method, path, body, label) => void write.send(method, path, body, label);
  const shared: Shared = { busy: write.busy || ui.pending !== null, post, setDraft, drafts };
  const usage = (list.page ?? list.retainedPage)?.usage;
  const changeScope = (next: SourceScope) => {
    const height = results.current?.getBoundingClientRect().height ?? 0;
    if (height > resultsMinHeight) setResultsMinHeight(height);
    update(() => ({ sourceScope: next }));
  };

  return <div className="sources-view">
    {usage && <p className="muted">{usage.activeUserDocuments}/{USER_DOCUMENT_LIMIT} documents · {usage.retainedVersions}/{SOURCE_LIMITS.retainedVersions} versions · {usage.codePoints.toLocaleString("en-US")}/{SOURCE_LIMITS.projectCodePoints.toLocaleString("en-US")} characters</p>}
    {selected ? <>
      {exact?.error && <p role="alert">{exact.error} <button type="button" className="button small" onClick={() => setHeadAttempt((value) => value + 1)}>Retry source</button></p>}
      <Reader selected={selected} correction={ui.sourceCorrections?.[selected.sourceId]} head={head} headFailed={Boolean(exact?.error)} canEdit={canEdit} update={update} refocus={refocus} onBack={(id) => { returnTo.current = id; }} {...shared} />
    </>
      : <>
        {canEdit && <AddSource {...shared} />}
        {canEdit && <FlowSource flows={savedDraft.document.flows} draftId={savedDraft.id} documentRevision={savedDraft.documentRevision} {...shared} />}
        <div role="group" aria-label="Source filter" className="sources-filter">
          {SCOPES.map(([id, label]) => <button key={id} type="button" className="button small" aria-pressed={scope === id} onClick={() => changeScope(id)}>{label}</button>)}
        </div>
        <div ref={results} className="sources-results" style={resultsMinHeight ? { minHeight: resultsMinHeight } : undefined}>
          {list.error && <p role="alert">{list.error} <button type="button" className="button small" onClick={list.retry}>Retry</button></p>}
          {!page ? !list.error && <p role="status">Loading sources…</p>
            : !page.items.length ? <p className="muted">{EMPTY[scope]}</p>
            : <ul className="sources-list">{page.items.map((item) => <li key={item.id}>
              <button type="button" className="specs-card" data-source-id={item.id} onClick={() => { setRefocus((count) => count + 1); update(() => ({ selected: { kind: "source", sourceId: item.id, versionId: null, back: ui.selected } })); }}>
                <strong>{item.displayNickname ?? item.title}</strong>
                <span className="specs-badge">{SOURCE_KIND_LABELS[item.kind]} · v{item.currentSequence} · {item.versionCount} {item.versionCount === 1 ? "version" : "versions"}{item.archived ? " · Archived" : ""}</span>
              </button></li>)}
            </ul>}
          {list.canLoadMore && <button type="button" className="button small" onClick={list.more}>Load more</button>}
        </div>
      </>}
  </div>;
}

function AddSource({ busy, post, drafts, setDraft }: Shared) {
  const title = drafts[NEW_TITLE] ?? "", text = drafts[NEW_TEXT] ?? "";
  const [fileError, setFileError] = useState("");
  const fileName = drafts[NEW_UPLOAD_NAME] ?? "";
  const uploaded = drafts["specs:new-source:uploaded"] === "true";
  const count = codePoints(text);
  const set = (key: string, value: string) => setDraft(key, value || undefined);
  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target, file = input.files?.[0];
    if (!file) return;
    const tooLarge = file.size > SOURCE_BODY_LIMIT;
    const decoded = tooLarge ? null : await readUtf8(file);
    input.value = "";
    if (decoded === null) { setFileError(tooLarge ? "This file is too large to add as a source." : "This file isn't valid UTF-8 text."); return; }
    setFileError(""); setDraft(NEW_UPLOAD_NAME, file.name); setDraft("specs:new-source:uploaded", "true");
    set(NEW_TEXT, decoded);
    if (!title) set(NEW_TITLE, [...file.name].slice(0, SOURCE_TITLE_LIMIT).join(""));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    post("POST", "sources", { title: title.trim(), text, ...(uploaded ? { uploaded: true } : {}) }, "Add source");
  };
  return <form className="detail-section" onSubmit={submit}>
    <h3>Add a source</h3>
    <div className="field"><label htmlFor="new-source-title">Source title</label><input id="new-source-title" value={title} readOnly={busy} maxLength={SOURCE_TITLE_LIMIT} onChange={(event) => set(NEW_TITLE, event.target.value)} /></div>
    <div className="field"><label htmlFor="new-source-text">Source text</label><textarea id="new-source-text" rows={6} value={text} readOnly={busy} onChange={(event) => { setDraft(NEW_UPLOAD_NAME, undefined); setDraft("specs:new-source:uploaded", undefined); set(NEW_TEXT, event.target.value); }} /></div>
    <div className="field"><span id="new-source-file-label" className="source-upload-label">Upload .txt or .md</span><label className="source-upload" htmlFor="new-source-file"><Icon name="importFlow" size={16} /><span>Choose file</span><span className="source-upload-name">{fileName || "No file selected"}</span><input id="new-source-file" aria-labelledby="new-source-file-label" type="file" disabled={busy} accept=".txt,.md,text/plain,text/markdown" onChange={(event) => void choose(event)} /></label></div>
    {fileError && <p role="alert">{fileError}</p>}
    <p className="muted" data-over={count > SOURCE_LIMITS.submissionCodePoints}>{count.toLocaleString("en-US")}/{SOURCE_LIMITS.submissionCodePoints.toLocaleString("en-US")} characters</p>
    <button type="submit" className="button primary" disabled={busy || !title.trim() || !text.trim() || count > SOURCE_LIMITS.submissionCodePoints}>Add source</button>
  </form>;
}

function FlowSource({ flows, draftId, documentRevision, busy, post, drafts, setDraft }: Shared & { flows: Record<string, { title: string }>; draftId: string; documentRevision: number }) {
  const flowId = drafts["specs:flow-source:id"] ?? "";
  const setFlowId = (value: string) => setDraft("specs:flow-source:id", value || undefined);
  const name = drafts[FLOW_TITLE] ?? "";
  const setName = (value: string) => setDraft(FLOW_TITLE, value || undefined);
  const ids = Object.keys(flows);
  const chosen = flows[flowId] ? flowId : ids[0] ?? "";
  const title = name || flows[chosen]?.title || "";
  if (!ids.length) return null;
  return <form className="detail-section" onSubmit={(event) => {
    event.preventDefault();
    post("POST", `drafts/${draftId}/graph-sources`, { expectedDocumentRevision: documentRevision, flowId: chosen, title: title.trim() }, "Save flow as source");
  }}>
    <h3>From saved flow</h3>
    <div className="field"><label htmlFor="flow-source-flow">Flow</label><select id="flow-source-flow" value={chosen} disabled={busy} onChange={(event) => { setFlowId(event.target.value); setName(""); }}>{ids.map((id) => <option key={id} value={id}>{flows[id]!.title}</option>)}</select></div>
    <div className="field"><label htmlFor="flow-source-title">Flow source title</label><input id="flow-source-title" value={title} readOnly={busy} maxLength={SOURCE_TITLE_LIMIT} onChange={(event) => setName(event.target.value)} /></div>
    <p className="muted">Uses the last saved version of the flow.</p>
    <button type="submit" className="button" disabled={busy || !title.trim()}>Add flow as source</button>
  </form>;
}

function Reader({ selected, correction, head, headFailed, canEdit, update, refocus, onBack, busy, post }: Shared & {
  selected: NonNullable<Extract<SpecsUi["selected"], { kind: "source" }>>; head: SourceHead | null; headFailed: boolean; canEdit: boolean; update: Update; refocus: number; onBack: (sourceId: string) => void;
  correction?: SourceCorrection;
}) {
  const { projectId } = useStudio();
  const viewId = selected.versionId ?? head?.currentVersionId ?? null;
  const [read, setRead] = useState<{ id: string; view?: SourceVersionView; error?: string } | null>(null);
  const [versions, setVersions] = useState<VersionList>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  const [versionError, setVersionError] = useState<{ key: string; message: string } | null>(null);
  const versionLifetime = useRef<AbortController | null>(null), loadingVersions = useRef(false);
  const versionsKey = head ? `${projectId}:${head.id}:${head.currentVersionId}:${readAttempt}` : "";
  useEffect(() => {
    if (!viewId) return;
    const controller = new AbortController();
    void apiRead<SourceVersionView>(`/api/projects/${projectId}/source-versions/${viewId}`, controller.signal).then((result) => {
      if (controller.signal.aborted || sessionEnded(result)) return;
      setRead(result.ok ? { id: viewId, view: result.data } : { id: viewId, error: result.message });
    });
    return () => controller.abort();
  }, [projectId, viewId, readAttempt]);
  useEffect(() => {
    if (!head) return;
    const controller = new AbortController();
    versionLifetime.current = controller;
    void apiRead<SourceVersionPage>(`/api/projects/${projectId}/sources/${head.id}/versions`, controller.signal).then((result) => {
      if (controller.signal.aborted || sessionEnded(result)) return;
      if (result.ok) { setVersions({ key: versionsKey, page: result.data }); setVersionError(null); }
      else setVersionError({ key: versionsKey, message: result.message });
    });
    return () => { controller.abort(); loadingVersions.current = false; };
    // The head's id and current version are what the list depends on; the head object itself changes more often.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, versionsKey]);
  const moreVersions = () => {
    const cursor = versions?.page.nextCursor;
    const controller = versionLifetime.current;
    if (!head || !cursor || versions?.key !== versionsKey || loadingVersions.current || !controller || controller.signal.aborted) return;
    loadingVersions.current = true;
    void apiRead<SourceVersionPage>(`/api/projects/${projectId}/sources/${head.id}/versions?cursor=${cursor}`, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      loadingVersions.current = false;
      if (sessionEnded(result)) return;
      if (result.ok) { setVersions((current) => appendVersionPage(current, versionsKey, cursor, result.data)); setVersionError(null); }
      else setVersionError({ key: versionsKey, message: result.message });
    });
  };

  const current = read?.id === viewId ? read : null;
  const view = current?.view;
  // After the person opens a source or commits a correction, archive or restore, focus moves to the heading once the (new) version is on screen.
  const heading = useRef<HTMLHeadingElement>(null), focused = useRef(0);
  useEffect(() => {
    if (view && refocus !== focused.current) { focused.current = refocus; heading.current?.focus(); }
  }, [refocus, view]);
  const goBack = () => { onBack(selected.sourceId); update(() => selected.back?.kind === "requirement" ? { section: "scope", selected: selected.back } : { selected: selected.back }); };
  const back = <button type="button" className="button quiet small" onClick={goBack}><Icon name="back" size={14} /><span>Back</span></button>;
  if (!head) return <>{back}{!headFailed && <p role="status">Loading source…</p>}</>;

  const editable = canEdit && isUser(head);
  const atHead = view?.id === head.currentVersionId;
  const title = correction?.title ?? view?.title ?? "", text = correction?.text ?? view?.text ?? "";
  const count = codePoints(text);
  const stale = correction && (correction.base.recordVersion !== head.version || correction.base.id !== head.currentVersionId);
  const changeCorrection = (change: (current: SourceCorrection | undefined) => SourceCorrection | undefined) => update((current) => {
    if (current.pending) return {};
    const sourceCorrections = { ...current.sourceCorrections }, next = change(sourceCorrections[head.id]);
    if (next) sourceCorrections[head.id] = next; else delete sourceCorrections[head.id];
    return { sourceCorrections };
  });
  const edit = (field: "title" | "text", value: string) => { if (view) changeCorrection((current) => editSourceCorrection(current, head, view, field, value)); };
  const correct = (event: FormEvent) => {
    event.preventDefault();
    if (correction) post("POST", `sources/${head.id}/versions`, sourceCorrectionBody(correction), "Save new version");
  };
  const archive = () => post("PATCH", `sources/${head.id}`, { expectedSourceRecordVersion: head.version, archived: !head.archived }, head.archived ? "Restore" : "Archive");

  return <div className="source-reader">
    {back}
    <h3 ref={heading} tabIndex={-1}>{head.displayNickname ?? view?.title ?? head.title}</h3>
    <p className="muted">{SOURCE_KIND_LABELS[head.kind]}{head.archived ? " · Archived" : ""}</p>
    {current?.error ? <p role="alert">{current.error} <button type="button" className="button small" onClick={() => setReadAttempt((value) => value + 1)}>Retry version</button></p> : !view ? <p role="status">Loading version…</p> : <>
      <div className="sources-filter">
        <p className="muted">Viewing v{view.sequence}; latest v{head.currentSequence}</p>
        {!atHead && <button type="button" className="button small" onClick={() => update(() => ({ selected: { ...selected, versionId: null, range: undefined } }))}>Latest</button>}
      </div>
      <SourceLines key={`${view.id}:${selected.range?.startLine ?? ""}:${selected.range?.endLine ?? ""}`} text={view.text} range={selected.range} />
    </>}
    {versionError?.key === versionsKey && <p role="alert">{versionError.message} <button type="button" className="button small" onClick={() => setReadAttempt((value) => value + 1)}>Retry versions</button></p>}
    {versions?.key === versionsKey && <section aria-label="Versions">
      <h3>Versions</h3>
      <ul className="sources-list">{versions.page.items.map((item) => <li key={item.id}>
        <button type="button" className="button quiet small" aria-pressed={item.id === viewId} onClick={() => update(() => ({ selected: { ...selected, versionId: item.id, range: item.id === selected.versionId ? selected.range : undefined } }))}>v{item.sequence}</button>{" "}
        <span className="muted">{item.codePointCount.toLocaleString("en-US")} characters</span>
      </li>)}</ul>
      {versions.page.nextCursor && <button type="button" className="button small" onClick={moreVersions}>Load more versions</button>}
    </section>}
    {editable && !head.archived && view && (atHead
      ? <form className="detail-section" onSubmit={correct}>
        <h3>Correct this source</h3>
        {stale && <section aria-label="Review newer source" className="detail-section">
          <p role="alert">This source changed while you were editing. Your correction is based on v{correction.base.sequence}. Review the current saved source before using your edits on it.</p>
          <h4>Current saved title</h4><p>{view.title}</p>
          <div className="field"><label htmlFor="current-saved-source-text">Current saved text</label><textarea id="current-saved-source-text" rows={8} readOnly value={view.text} /></div>
          <button type="button" className="button" disabled={busy} onClick={() => changeCorrection((current) => current && reconcileSourceCorrection(current, head, view))}>Use my edits on latest version</button>
        </section>}
        <div className="field"><label htmlFor="corrected-title">Corrected title</label><input id="corrected-title" value={title} readOnly={busy} maxLength={SOURCE_TITLE_LIMIT} onChange={(event) => edit("title", event.target.value)} /></div>
        <div className="field"><label htmlFor="corrected-text">Corrected text</label><textarea id="corrected-text" rows={8} value={text} readOnly={busy} onChange={(event) => edit("text", event.target.value)} /></div>
        <p className="muted">{count.toLocaleString("en-US")}/{SOURCE_LIMITS.submissionCodePoints.toLocaleString("en-US")} characters</p>
        <button type="submit" className="button primary" disabled={busy || !correction || !title.trim() || !text.trim() || count > SOURCE_LIMITS.submissionCodePoints}>Save new version</button>
        {correction && <button type="button" className="button" disabled={busy} onClick={() => changeCorrection(() => undefined)}>Discard my correction</button>}
      </form>
      : <p className="muted">Open the latest version to correct it.</p>)}
    {editable && <button type="button" className="button" disabled={busy} onClick={archive}>{head.archived ? "Restore" : "Archive"}</button>}
  </div>;
}
