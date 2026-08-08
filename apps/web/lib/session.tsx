'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, endpoints, getAccessToken, setAccessToken, type MeResponse, type OnboardingStatus } from './api';

/**
 * 세션 상태 (§8.4, §8.5).
 *
 * **"비로그인"과 "온보딩 미완료"를 구분한다.** 온보딩 게이트는 미완료 세션의 접근을
 * 온보딩 경로로만 제한하므로 `/me` 가 403 으로 막힌다(§8.5). 이 둘을 묶어 버리면
 * 로그인에 성공한 사용자가 계속 로그인 화면으로 되돌아가고, 화면은 이유를 말해 주지 못한다.
 */
type SessionPhase = 'loading' | 'anonymous' | 'onboarding' | 'ready';

interface SessionState {
  phase: SessionPhase;
  me: MeResponse | null;
  /** phase='onboarding' 일 때 남은 항목 */
  onboarding: OnboardingStatus | null;
  loading: boolean;
  /** 표시 분기 전용 — 서버의 403/404 를 대신하지 않는다(§3, §8.4) */
  can: (permissionCode: string) => boolean;
  refresh: () => Promise<void>;
  logout: () => void;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingStatus | null>(null);
  const [phase, setPhase] = useState<SessionPhase>('loading');

  const refresh = useCallback(async () => {
    setPhase('loading');
    if (!getAccessToken()) {
      setMe(null);
      setOnboarding(null);
      setPhase('anonymous');
      return;
    }
    try {
      setMe(await endpoints.me());
      setOnboarding(null);
      setPhase('ready');
    } catch (error) {
      // 403 은 "권한 없음"이지만, 토큰이 있는데 /me 조차 막혔다면 온보딩 게이트다(§8.5).
      // 남은 항목을 물어 확인한다 — 이 경로는 미완료 세션에도 열려 있다.
      if (error instanceof ApiError && error.status === 403) {
        try {
          const status = await endpoints.onboardingStatus();
          setMe(null);
          setOnboarding(status);
          setPhase('onboarding');
          return;
        } catch {
          // 온보딩 경로마저 막히면 세션 자체가 무효다
        }
      }
      setAccessToken(null);
      setMe(null);
      setOnboarding(null);
      setPhase('anonymous');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<SessionState>(
    () => ({
      phase,
      me,
      onboarding,
      loading: phase === 'loading',
      can: (code) => me?.permissions.some((p) => p.code === code) ?? false,
      refresh,
      logout: () => {
        setAccessToken(null);
        setMe(null);
        setOnboarding(null);
        setPhase('anonymous');
      },
    }),
    [phase, me, onboarding, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('SessionProvider 안에서만 사용할 수 있습니다.');
  return ctx;
}
