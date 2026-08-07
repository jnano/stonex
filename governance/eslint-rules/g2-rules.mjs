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
