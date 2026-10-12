import type { HostClient } from "@vagus/client";
import { useCallback, useEffect, useState } from "react";

const PAGE_SIZE = 30;
interface SearchResultState {
  query: string;
  ids: Set<string>;
  nextOffset: number;
  hasMore: boolean;
  loadingMore: boolean;
}

export function useSessionSearch(host: HostClient, query: string, enabled: boolean, archived = false, revision = 0) {
  const normalized = query.trim().toLocaleLowerCase();
  const [result, setResult] = useState<SearchResultState | null>(null);
  useEffect(() => {
    if (!enabled || !normalized) { setResult(null); return; }
    let active = true;
    setResult(null);
    const timer = window.setTimeout(() => {
      void host.request("sessions.search", { query: normalized, archived, limit: PAGE_SIZE, offset: 0 }).then((page) => {
        if (active) setResult({ query: normalized, ids: new Set(page.ids), nextOffset: page.nextOffset, hasMore: page.hasMore, loadingMore: false });
      }).catch(() => {
        if (active) setResult({ query: normalized, ids: new Set(), nextOffset: 0, hasMore: false, loadingMore: false });
      });
    }, 150);
    return () => { active = false; window.clearTimeout(timer); };
  }, [host, normalized, enabled, archived, revision]);

  const current = result?.query === normalized ? result : null;
  const loadMore = useCallback(() => {
    if (!current || !current.hasMore || current.loadingMore) return;
    const { nextOffset } = current;
    setResult({ ...current, loadingMore: true });
    void host.request("sessions.search", { query: normalized, archived, limit: PAGE_SIZE, offset: nextOffset }).then((page) => {
      setResult((latest) => {
        if (latest?.query !== normalized || latest.nextOffset !== nextOffset) return latest;
        return { query: normalized, ids: new Set([...latest.ids, ...page.ids]), nextOffset: page.nextOffset, hasMore: page.hasMore, loadingMore: false };
      });
    }).catch(() => {
      setResult((latest) => latest?.query === normalized ? { ...latest, loadingMore: false, hasMore: false } : latest);
    });
  }, [archived, current, host, normalized]);

  return {
    ids: current?.ids ?? null,
    hasMore: current?.hasMore ?? false,
    loading: enabled && Boolean(normalized) && current === null,
    loadingMore: current?.loadingMore ?? false,
    loadMore,
  };
}
