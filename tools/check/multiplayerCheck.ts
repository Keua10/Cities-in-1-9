import assert from 'node:assert/strict';
import { sharedClockOffset, sharedNow, syncSharedClock } from '../../src/sim/sharedClock';

/**
 * 군사 3단계 — 공유 시계.
 *  - 서버 시각을 받으면 왕복 시간의 가운데 기준으로 차이를 잰다.
 *  - 그 뒤 값은 튀지 않게 천천히 따라간다.
 * (공개 문서·접속 표시는 Firebase 가 있어야 해서 브라우저에서 확인한다.)
 */
assert.equal(sharedClockOffset().synced, false);
const local = Date.now();
syncSharedClock(local + 5_000, local - 100, local + 100);
const off = sharedClockOffset();
assert.ok(off.synced && Math.abs(off.offsetMs - 5_000) < 300, `첫 동기화 (${off.offsetMs})`);
assert.ok(Math.abs(sharedNow() - (Date.now() + off.offsetMs)) < 5);
syncSharedClock(Date.now() + 15_000, Date.now(), Date.now());
const after = sharedClockOffset().offsetMs;
assert.ok(after > 5_000 && after < 15_000, '두 번째부터는 천천히 따라간다');
console.log('Multiplayer passed: shared clock sync.');
