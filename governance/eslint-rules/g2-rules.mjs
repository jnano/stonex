// G-2 금지 패턴 (1차: ESLint AST 셀렉터. 2차 Semgrep 의미 패턴은 WP-3에서 추가)
// 근거: 기획서 INV-1(권한 검사는 Permission 코드로만), INV-2(서열 필드 보안 규칙 사용 금지)

const EQ = '/^(===?|!==?)$/';
const CMP = '/^(<|>|<=|>=|===?|!==?)$/';

const INV1_MSG =
  "INV-1 위반: 역할 코드 직접 비교 금지. can(subject, permissionCode, resource?)를 사용하세요.";
const INV2_MSG =
  'INV-2 위반: display_order는 정렬·표시 전용입니다. 비교·판정 로직 사용 금지.';

export const g2RestrictedSyntax = [
  // role === 'ADMIN' / user.role !== 'X' 류
  { selector: `BinaryExpression[operator=${EQ}] > Identifier[name='role']`, message: INV1_MSG },
  { selector: `BinaryExpression[operator=${EQ}] > MemberExpression[property.name='role']`, message: INV1_MSG },
  { selector: `SwitchStatement > MemberExpression[property.name='role']`, message: INV1_MSG },
  // display_order 비교 (snake_case·camelCase 모두)
  { selector: `BinaryExpression[operator=${CMP}] > Identifier[name=/^(display_order|displayOrder)$/]`, message: INV2_MSG },
  { selector: `BinaryExpression[operator=${CMP}] > MemberExpression[property.name=/^(display_order|displayOrder)$/]`, message: INV2_MSG },
];

/**
 * 프론트엔드 전용 추가 룰 (WP-15 후속).
 *
 * 기획서 §3·§8.4: **프론트의 표시 분기는 UX 목적이며 보안 경계가 아니다.**
 * 그러나 화면이 늘면 "여기서만 잠깐" 권한을 직접 판단하는 코드가 스며들고, 그 사본은
 * 서버 규칙이 바뀔 때 따라가지 못해 **보이는 것과 실제가 어긋난다**.
 *
 * 유일한 통로는 `useSession().can(permissionCode)` 다. 역할 코드로 분기하거나
 * 권한 배열을 직접 뒤지는 것을 여기서 막는다.
 */
const WEB_MSG =
  '프론트에서 권한을 재구현하지 마십시오 (§3·§8.4). 표시 분기는 useSession().can(코드) 를 쓰고, ' +
  '실제 차단은 서버의 403/404 에 맡깁니다.';

export const g2WebRestrictedSyntax = [
  // me.roles.includes('SUPER_ADMIN') 류 — 역할 코드로 화면을 가르는 패턴
  {
    selector: "CallExpression[callee.property.name='includes'][callee.object.property.name='roles']",
    message: WEB_MSG,
  },
  // permissions 배열을 직접 뒤지는 패턴 (session.tsx 의 can() 구현만 예외)
  {
    selector:
      "CallExpression[callee.property.name=/^(some|find|filter|includes)$/][callee.object.property.name='permissions']",
    message: WEB_MSG,
  },
  // ── board 모듈 기여 (WP-B2, R-B2): body_md 프론트 직접 렌더 금지 ──
  // 표시는 서버가 렌더·새니타이즈한 body_html 만 쓴다. 프론트에 마크다운 렌더러를
  // 들이는 순간 새니타이즈 위치가 둘로 갈라져 우회 경로가 된다(스펙 §7.1).
  {
    selector:
      "ImportDeclaration[source.value=/^(markdown-it|marked|react-markdown|remark|showdown|micromark)/]",
    message:
      '프론트에서 마크다운을 직접 렌더하지 마십시오(R-B2). 표시는 서버 렌더 캐시(bodyHtml)만 사용합니다.',
  },
];
