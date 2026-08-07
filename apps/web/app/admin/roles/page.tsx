'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  endpoints,
  type PermissionCatalogItem,
  type RoleDetail,
  type RoleSummary,
} from '../../../lib/api';
import { useSession } from '../../../lib/session';

/**
 * 역할 목록·매핑 편집 (ADM-1~3).
 *
 * 미보유 Permission 은 체크 자체를 막지만, 이는 UX 보조일 뿐이며
 * 실제 차단은 서버의 ADM-3 규칙이 수행한다(§10.1).
 * 매핑 저장은 전체 치환 방식이다(§7.2).
 */
export default function RolesPage() {
  const { me, can } = useSession();
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [selected, setSelected] = useState<RoleDetail | null>(null);
  const [catalog, setCatalog] = useState<PermissionCatalogItem[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [list, cat] = await Promise.all([endpoints.roles(), endpoints.permissionCatalog()]);
    setRoles(list);
    setCatalog(cat);
  }, []);

  useEffect(() => {
    if (me) void load().catch((e: Error) => setMessage(e.message));
  }, [me, load]);

  const select = async (id: string) => {
    setMessage(null);
    const detail = await endpoints.role(id);
    setSelected(detail);
    setChecked(new Set(detail.permissions.map((p) => p.code)));
  };

  const save = async () => {
    if (!selected) return;
    setMessage(null);
    try {
      const updated = await endpoints.setRolePermissions(selected.id, [...checked]);
      setSelected(updated);
      setMessage('저장했습니다. 보유자의 권한이 수 초 내 반영됩니다.');
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '저장 실패');
    }
  };

  if (!me) return <main style={{ padding: 32 }}>로그인이 필요합니다.</main>;
  if (!can('admin.role.read')) return <main style={{ padding: 32 }}>역할 조회 권한이 없습니다.</main>;

  const editable = can('admin.role.manage');

  return (
    <main style={{ padding: 32, maxWidth: 1000, margin: '0 auto', display: 'grid', gridTemplateColumns: '280px 1fr', gap: 24 }}>
      <section>
        <h1 style={{ fontSize: 20 }}>역할</h1>
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {roles.map((r) => (
            <li key={r.id} style={{ marginBottom: 6 }}>
              <button onClick={() => void select(r.id)} style={{ width: '100%', textAlign: 'left' }}>
                {r.name} ({r.code}) · 보유 {r.holderCount}
                {r.isSystem && ' · 시스템'}
                {r.requires2fa && ' · 2FA'}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        {selected ? (
          <>
            <h2 style={{ fontSize: 18 }}>
              {selected.name} ({selected.code})
            </h2>
            <p style={{ color: '#555' }}>
              보유자 {selected.holderCount}명 · {selected.isSystem ? '시스템 역할(삭제·코드 변경 불가)' : '일반 역할'}
              {selected.requires2fa && ' · 이 역할 보유자는 2FA 필수'}
            </p>
            <div style={{ display: 'grid', gap: 4, maxHeight: 420, overflow: 'auto', border: '1px solid #ddd', padding: 12 }}>
              {catalog.map((p) => (
                <label key={p.code} style={{ opacity: p.assignable || checked.has(p.code) ? 1 : 0.45 }}>
                  <input
                    type="checkbox"
                    checked={checked.has(p.code)}
                    disabled={!editable || (!p.assignable && !checked.has(p.code))}
                    onChange={(e) => {
                      const next = new Set(checked);
                      if (e.target.checked) next.add(p.code);
                      else next.delete(p.code);
                      setChecked(next);
                    }}
                  />{' '}
                  <code>{p.code}</code> <span style={{ color: '#666' }}>({p.scope}) {p.description}</span>
                  {!p.assignable && !checked.has(p.code) && (
                    <span style={{ color: '#a15c00' }}> — 보유하지 않아 부여 불가</span>
                  )}
                </label>
              ))}
            </div>
            {editable && (
              <button onClick={() => void save()} style={{ marginTop: 12 }}>
                매핑 저장 (전체 치환)
              </button>
            )}
          </>
        ) : (
          <p>왼쪽에서 역할을 선택하세요.</p>
        )}
        {message && <p style={{ color: message.includes('저장했습니다') ? '#0a7' : '#b00020' }}>{message}</p>}
      </section>
    </main>
  );
}
