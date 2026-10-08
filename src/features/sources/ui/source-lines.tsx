"use client";

import { useMemo, useState } from "react";
import { SOURCE_LINES_PER_PAGE, sourceLinePage } from "./source-line-pages";

/** Keyed by immutable version by the reader, so changing versions always opens its first page. */
export default function SourceLines({ text, range }: { text: string; range?: { startLine: number; endLine: number } }) {
  const initial = range ? Math.floor((range.startLine - 1) / SOURCE_LINES_PER_PAGE) : 0;
  const [page, setPage] = useState(initial);
  const shown = useMemo(() => sourceLinePage(text, page), [text, page]);
  return <section aria-label="Source text" className="source-text">
    <ol className="source-lines" aria-label="Source lines" start={shown.firstLine}>{shown.lines.map((line, index) => {
      const number = shown.firstLine + index;
      return <li key={number} data-cited={range && number >= range.startLine && number <= range.endLine ? "true" : undefined}>{line}</li>;
    })}</ol>
    {shown.lastPage > 0 && <div role="group" aria-label="Source line pages" className="sources-filter">
      <p role="status">Lines {shown.firstLine.toLocaleString("en-US")}-{shown.lastLine.toLocaleString("en-US")} of {shown.totalLines.toLocaleString("en-US")}</p>
      <button type="button" className="button small" disabled={shown.page === 0} onClick={() => setPage(0)}>First lines</button>
      <button type="button" className="button small" disabled={shown.page === 0} onClick={() => setPage(shown.page - 1)}>Previous lines</button>
      <button type="button" className="button small" disabled={shown.page === shown.lastPage} onClick={() => setPage(shown.page + 1)}>Next lines</button>
      <button type="button" className="button small" disabled={shown.page === shown.lastPage} onClick={() => setPage(shown.lastPage)}>Last lines</button>
    </div>}
  </section>;
}
