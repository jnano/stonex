'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { endpoints, setAccessToken, type MeResponse } from './api';

interface SessionState {
  me: MeResponse | null;
  loading: boolean;
  /** 표시 분기 전용 — 서버의 403/404 를 대신하지 않는다(§3, §8.4) */
  can: (permissionCode: string) => boolean;
  refresh: () => Promise<void>;
  logout: () => void;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setMe(await endpoints.me());
    } catch {
      setMe(null); // 401 이면 비로그인 상태로 취급 (재로그인 유도)
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<SessionState>(
    () => ({
      me,
      loading,
      can: (code) => me?.permissions.some((p) => p.code === code) ?? false,
      refresh,
      logout: () => {
        setAccessToken(null);
        setMe(null);
      },
    }),
    [me, loading, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('SessionProvider 안에서만 사용할 수 있습니다.');
  return ctx;
}
