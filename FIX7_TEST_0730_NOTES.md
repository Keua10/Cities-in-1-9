# FIX7 테스트 daytime 시작 시각

- 테스트 중에는 실제 벽시계를 사용하지 않는다.
- 페이지/게임 세션에 접속할 때마다 daytime은 **월요일 07:30**에서 시작한다.
- 이후 daytime은 기존과 동일하게 **실제 600초 = daytime 1일** 속도로 진행한다.
- gametime 속도와 규칙은 변경하지 않았다.
- 일출/일몰은 계속 계절 표현에만 사용하며 출퇴근 시각을 바꾸지 않는다.
- 정식 운영 전에는 `sessionDaytimeAt()` 사용을 제거하고 영속 daytime 정책을 다시 연결해야 한다.

변경 파일:
- `src/sim/time.ts`
- `src/sim/traffic/trafficSim.ts`
- `src/main.ts`
