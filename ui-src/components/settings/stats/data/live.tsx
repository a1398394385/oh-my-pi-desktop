import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import * as api from "../api";
import type { LiveStatus, LiveSyncStatus } from "../types";

export interface LiveState {
  version: number;
  sync: LiveSyncStatus;
  indexingHours: number;
  connected: boolean;
  requestSync: () => void;
}

const IDLE_SYNC: LiveSyncStatus = {
  phase: "idle",
  current: 0,
  total: 0,
  processed: 0,
  lastSyncedAt: null,
  error: null,
};

const LiveContext = createContext<LiveState>({
  version: 0,
  sync: IDLE_SYNC,
  indexingHours: 0,
  connected: false,
  requestSync: () => {},
});

export function LiveProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<{ server: LiveStatus | null; version: number }>({ server: null, version: 0 });
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const base = api.getApiBase();
    if (!base) return;

    let source: EventSource | null = null;
    try {
      source = new EventSource(`${base}/api/events`);
      source.onopen = () => setConnected(true);
      source.onerror = () => setConnected(false);
      source.onmessage = (event) => {
        try {
          const next = JSON.parse(event.data) as LiveStatus;
          setStatus((prev) => ({
            server: next,
            version: prev.server && prev.server.version === next.version ? prev.version : prev.version + 1,
          }));
        } catch {}
      };
    } catch {
      setConnected(false);
    }

    return () => {
      source?.close();
    };
  }, []);

  const requestSync = useCallback(() => {
    api.requestSync().catch(() => {});
  }, []);

  const value = useMemo<LiveState>(
    () => ({
      version: Math.max(0, status.version - 1),
      sync: status.server?.sync ?? IDLE_SYNC,
      indexingHours: status.server?.indexingHours ?? 0,
      connected,
      requestSync,
    }),
    [status, connected, requestSync],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveState {
  return useContext(LiveContext);
}
