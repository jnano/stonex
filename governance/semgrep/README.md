# G-2 2차 — Semgrep 의미 패턴 룰

평가기(`AuthorizationService`)·`PolicyService`를 우회하는 직접 쿼리 패턴 검출 룰의 위치.
**WP-3에서 평가기 모듈 경계가 확정된 후 작성한다** (작업지시서 WP-3 항목 7). 그 전까지 1차 방어는 `../eslint-rules/`의 AST 셀렉터가 담당한다.
