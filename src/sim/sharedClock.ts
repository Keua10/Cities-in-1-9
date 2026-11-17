/**
 * 공유 시계 (군사 3단계).
 *
 * 기기마다 시계가 조금씩 다르다. 전쟁(4단계~)에서 두 도시가 같은 순간을 봐야 하므로
 * 서버 시각과의 차이(offset)를 재 두고, 모두가 sharedNow() 를 기준으로 쓴다.
 * 차이는 접속 표시(net/presence.ts)가 서버 시각을 받아 올 때마다 고친다.
 * 서버가 없으면(둘러보기) 이 기기 시계 그대로다.
 */

let offsetMs = 0;
let synced = false;

/** 서버 시각(ms) 기준의 지금. */
export function sharedNow(): number {
  return Date.now() + offsetMs;
}

/** 서버 시각 serverMs 를 localBefore~localAfter 사이에 받았다. 왕복 시간의 가운데로 본다. */
export function syncSharedClock(serverMs: number, localBefore: number, localAfter: number): void {
  const mid = (localBefore + localAfter) / 2;
  const next = serverMs - mid;
  // 첫 값은 그대로, 그 뒤로는 튀지 않게 천천히 따라간다.
  offsetMs = synced ? offsetMs + (next - offsetMs) * 0.3 : next;
  synced = true;
}

export function sharedClockOffset(): { offsetMs: number; synced: boolean } {
  return { offsetMs, synced };
}
