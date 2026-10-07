/** Bound rendered logical lines independently of the source's character budget. */
export const SOURCE_LINES_PER_PAGE = 100;

export function sourceLinePage(text: string, requestedPage: number) {
  const lines = text.split("\n"); // keep the last empty line: it is part of the exact source
  const lastPage = Math.ceil(lines.length / SOURCE_LINES_PER_PAGE) - 1;
  const page = Math.min(lastPage, Math.max(0, Number.isSafeInteger(requestedPage) ? requestedPage : 0));
  const offset = page * SOURCE_LINES_PER_PAGE;
  return { lines: lines.slice(offset, offset + SOURCE_LINES_PER_PAGE), page, lastPage,
    firstLine: offset + 1, lastLine: Math.min(offset + SOURCE_LINES_PER_PAGE, lines.length), totalLines: lines.length };
}
