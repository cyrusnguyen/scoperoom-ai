"use client";

import type { RunSummary } from "../contracts/tasks";
import { Icon } from "@/features/shell/ui/icon";

export function RunHistory({ runs, selectedId, nextCursor, loading, onSelect, onMore }: { runs: RunSummary[]; selectedId: string | null; nextCursor: string | null; loading: boolean; onSelect: (id: string) => void; onMore: () => void }) {
  return <section className="detail-section ai-history" aria-labelledby="ai-history-heading">
    <header className="ai-history-header"><h2 id="ai-history-heading">Recent runs</h2><span className="ai-history-count">{runs.length}{nextCursor ? "+" : ""}</span></header>
    {!runs.length ? <p className="muted">No AI runs yet.</p> : <ul className="ai-history-list">
      {runs.map((run) => <li key={run.id} data-run-id={run.id}><button type="button" className="ai-history-item" aria-current={selectedId === run.id ? "true" : undefined} onClick={() => onSelect(run.id)}>
        <span className="ai-history-title"><Icon name="flow" size={14} />{run.taskType === "PROPOSE_FLOW" ? "Generate flow" : "Improve selection"}</span><span className="ai-history-state" data-state={run.state}>{run.state.toLowerCase().replaceAll("_", " ")}</span>
        <small>{new Date(run.createdAt).toLocaleString()} · input {run.usage.inputTokens ?? "unknown"}, output {run.usage.outputTokens ?? "unknown"}</small>
      </button></li>)}
    </ul>}
    {nextCursor && <button type="button" className="button quiet small" onClick={onMore} disabled={loading}>{loading ? "Loading older runs…" : "Load older runs"}</button>}
  </section>;
}
