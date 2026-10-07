import type { SourcePage, SourceScope, SourceVersionPage } from "../contracts/source-version.ts";

/** One loaded list: which project and filter it belongs to, and which first-page load produced it. */
export type SourceList = { key: string; ticket: number; page: SourcePage } | null;

export const listKey = (projectId: string, scope: SourceScope) => `${projectId}:${scope}`;

/** A new first-page load keeps the rows of the same list (a revision refresh) and drops a different project's or filter's. */
export const startSourceList = (list: SourceList, key: string): SourceList => (list?.key === key ? list : null);

export const acceptFirstPage = (key: string, ticket: number, page: SourcePage): SourceList => ({ key, ticket, page });

/** More only continues the list the current load accepted: never a held, failed or other-filter first page. */
export const canLoadMore = (list: SourceList, key: string, ticket: number) => Boolean(list && list.key === key && list.ticket === ticket && list.page.nextCursor);

/** Appends a later page only to the same list, load and cursor (no stale or repeated page). */
export function appendSourcePage(list: SourceList, key: string, ticket: number, cursor: string, next: SourcePage): SourceList {
  if (!list || list.key !== key || list.ticket !== ticket || list.page.nextCursor !== cursor) return list;
  return { key, ticket, page: { ...next, items: [...list.page.items, ...next.items] } };
}

export type VersionList = { key: string; page: SourceVersionPage } | null;
/** The key includes the source, current head and read attempt; a cursor may be appended once only. */
export function appendVersionPage(list: VersionList, key: string, cursor: number, next: SourceVersionPage): VersionList {
  if (!list || list.key !== key || list.page.nextCursor !== cursor) return list;
  return { key, page: { ...next, items: [...list.page.items, ...next.items] } };
}
