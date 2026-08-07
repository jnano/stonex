'use client';

import { useCallback, useEffect, useState } from 'react';
import { endpoints, type DominanceCheck, type MemberSummary } from '../../../lib/api';
import { useSession } from '../../../lib/session';

/**
 * 회원 목록·관리 (MEM-2~4).
 *
 * 관리 버튼의 활성 여부와 안내 문구는 서버의 "관리 가능/불가 + 사유" 판정을 그대로 쓴다(§4.6-3).
 * 프론트에서 우위 검사를 재구현하지 않는다 — 규칙이 두 곳에 있으면 반드시 어긋난다.
 */
export default function MembersPage() {
  const { me, can } = useSession();
  const [members, setMembers] = useState<MemberSummary[]>([]);
  const [checks, setChecks] = useState<Record<string, DominanceCheck>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { items } = await endpoints.members();
      setMembers(items);
      const entries = await Promise.all(
        items.map(async (m) => [m.id, await endpoints.manageable(m.id)] as const),
      );
      setChecks(Object.fromEntries(entries));
    } catch (e) {
      setError(e instanceof Error ? e.message : '조회 실패');
    }
  }, []);

  useEffect(() => {
    if (me) void load();
  }, [me, load]);

  const toggleBan = async (m: MemberSummary) => {
    setError(null);
    try {
      if (m.status === 'SUSPENDED') await endpoints.unban(m.id);
      else await endpoints.ban(m.id);
      await load();
    } catch (e) {
      // 서버가 거부하면 그대로 표시한다 (표시 분기는 보조 수단일 뿐)
      setError(e instanceof Error ? e.message : '처리 실패');
    }
  };

  if (!me) return <main style={{ padding: 32 }}>로그인이 필요합니다.</main>;
  if (!can('member.read')) return <main style={{ padding: 32 }}>회원 조회 권한이 없습니다.</main>;

  return (
    <main style={{ padding: 32, maxWidth: 960, margin: '0 auto' }}>
      <h1>회원 관리</h1>
      {error && <p style={{ color: '#b00020' }}>{error}</p>}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
            <th>이메일</th><th>이름</th><th>상태</th><th>관리 가능</th><th></th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => {
            const check = checks[m.id];
            return (
              <tr key={m.id} style={{ borderBottom: '1px solid #eee' }}>
                <td>{m.email}</td>
                <td>{m.name}</td>
                <td>{m.status}</td>
                <td title={check?.missing.length ? `부족 권한: ${check.missing.join(', ')}` : undefined}>
                  {check ? (check.manageable ? '가능' : `불가 — ${check.reason}`) : '…'}
                </td>
                <td>
                  {can('member.ban') && (
                    <button
                      onClick={() => void toggleBan(m)}
                      disabled={!check?.manageable}
                      title={check?.manageable ? undefined : check?.reason}
                    >
                      {m.status === 'SUSPENDED' ? '해제' : '정지'}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}
