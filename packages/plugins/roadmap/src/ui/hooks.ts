import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHostLocation, useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import { parseRoadmapLocation, roadmapHref, type RoadmapView } from "./route.ts";

export { PAGE_PATH, roadmapHref, type RoadmapRoute, type RoadmapView } from "./route.ts";
export const MOBILE_QUERY = "(max-width: 767px)";

// ---------------------------------------------------------------------------
// Browser storage: per-viewer conveniences only, never required.
// ---------------------------------------------------------------------------

export function readStorage<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or blocked storage: the page works without it.
  }
}

export function lastRouteKey(companyId: string): string {
  return `paperclip.roadmap.last.${companyId}`;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(MOBILE_QUERY).matches : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(MOBILE_QUERY);
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return mobile;
}

// ---------------------------------------------------------------------------
// Route: /:prefix/roadmap[/overview|/flow|/list][?project=<id>] (see route.ts)
// ---------------------------------------------------------------------------

export function useRoadmapRoute(companyId: string) {
  const location = useHostLocation();
  const { navigate } = useHostNavigation();
  const route = useMemo(
    () => parseRoadmapLocation(location.pathname, location.search),
    [location.pathname, location.search],
  );

  const setRoute = useCallback(
    (projectId: string | null, view: RoadmapView, options?: { replace?: boolean }) => {
      const effectiveView: RoadmapView = projectId ? view : "overview";
      writeStorage(lastRouteKey(companyId), { projectId, view: effectiveView });
      navigate(roadmapHref(projectId, effectiveView), { replace: options?.replace ?? false });
    },
    [companyId, navigate],
  );

  return { route, setRoute };
}

// ---------------------------------------------------------------------------
// Data: keep the last good snapshot per request so a refresh never blanks
// the screen and an error never hides what was already loaded.
// ---------------------------------------------------------------------------

export function useLastGood<T>(key: string, data: T | null, matches: (data: T) => boolean): T | null {
  const store = useRef(new Map<string, T>());
  if (data !== null && matches(data)) store.current.set(key, data);
  return store.current.get(key) ?? null;
}

/** Refreshes when the tab becomes visible again, at most every 30 seconds. */
export function useRefreshOnFocus(refresh: () => void, minIntervalMs = 30_000): void {
  const last = useRef(Date.now());
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (typeof document === "undefined") return;
    const maybeRefresh = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - last.current < minIntervalMs) return;
      last.current = Date.now();
      refreshRef.current();
    };
    document.addEventListener("visibilitychange", maybeRefresh);
    window.addEventListener("focus", maybeRefresh);
    return () => {
      document.removeEventListener("visibilitychange", maybeRefresh);
      window.removeEventListener("focus", maybeRefresh);
    };
  }, [minIntervalMs]);
}

/** Collapsed lanes, remembered per viewer and project. */
export function useCollapsedLanes(storageKey: string, defaults: ReadonlySet<string>) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>(() => readStorage<Record<string, boolean>>(storageKey) ?? {});
  useEffect(() => {
    setOverrides(readStorage<Record<string, boolean>>(storageKey) ?? {});
  }, [storageKey]);
  const isCollapsed = useCallback(
    (laneId: string) => overrides[laneId] ?? defaults.has(laneId),
    [overrides, defaults],
  );
  const toggle = useCallback(
    (laneId: string) => {
      setOverrides((current) => {
        const next = { ...current, [laneId]: !(current[laneId] ?? defaults.has(laneId)) };
        writeStorage(storageKey, next);
        return next;
      });
    },
    [defaults, storageKey],
  );
  return { isCollapsed, toggle };
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatRelativeDays(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const days = Math.floor((now - time) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}
