/** G-2 실증용 위반 코드 — 이 PR은 CI 실패 확인 후 병합 없이 닫는다 */
declare const role: string;
export function isAdmin(): boolean {
  return role === 'ADMIN';
}
