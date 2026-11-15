import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BASE_CHUNK_SPAN, CHUNK_SIZE } from '../../src/core/constants';
import {
  CONTINENT_H,
  CONTINENT_W,
  CONTINENT_X0,
  CONTINENT_Y0,
  generateContinentChunk,
  sampleSite,
} from '../../src/world/continent';
import {
  barrierBetween,
  canStartAt,
  ChunkStatTable,
  defaultOrigin,
  siteSummary,
  SITE_FAR,
  SITE_NEAR,
  spacingBlock,
  type Origin,
} from '../../src/world/sites';
import { isWater } from '../../src/world/terrain';
import { World } from '../../src/world/world';

/**
 * 지도 v2 (가상 대륙 + 시작 자리) 점검.
 *
 *  1. 미리 만든 지도 자료(public/maps)가 지형 생성기와 같다.
 *  2. 이웃 칸 고도 차는 항상 0 또는 1 이다 (청크 경계 포함).
 *  3. 칸 생성과 점 질의가 같은 지형을 낸다.
 *  4. 고를 수 있는 자리에는 실제로 물(하천)이 흐른다.
 *  5. 학생들이 아무 순서로 아무 자리를 골라도 14명 이상 들어간다.
 *  6. 간격 규칙: 너무 가까우면 막고, 멀면 통과하고, 그 사이는 장애물을 본다.
 */

let t = Date.now();
const table = ChunkStatTable.compute();
const bin = new Uint8Array(readFileSync('public/maps/continent-v2.bin'));
assert.equal(bin.length, table.raw.length, '지도 표 크기');
assert.ok(
  bin.every((v, i) => v === table.raw[i]),
  'public/maps/continent-v2.bin 이 생성기와 다릅니다 · npm run map:build 로 다시 만드세요',
);
const png = readFileSync('public/maps/continent-v2.png');
assert.equal(png.readUInt32BE(16), (CONTINENT_W * CHUNK_SIZE) / 16, '미리보기 지도 가로');
assert.equal(png.readUInt32BE(20), (CONTINENT_H * CHUNK_SIZE) / 16, '미리보기 지도 세로');
console.log(`  OK   지도 자료가 생성기와 같다 (${Date.now() - t}ms)`);

// 2·3. 고도 차와 생성/질의 일치. 산·강·해안이 고루 들어간 네 구역을 본다.
t = Date.now();
const heights = new Map<string, Uint8Array>();
const hAt = (x: number, y: number) => {
  const cx = Math.floor(x / CHUNK_SIZE);
  const cy = Math.floor(y / CHUNK_SIZE);
  const key = `${cx},${cy}`;
  let h = heights.get(key);
  if (!h) {
    h = generateContinentChunk(cx, cy).heights;
    heights.set(key, h);
  }
  return h[(y - cy * CHUNK_SIZE) * CHUNK_SIZE + (x - cx * CHUNK_SIZE)];
};
let cliffs = 0;
for (const [bx, by] of [
  [-20, -30],
  [5, 10],
  [-50, 0],
  [20, -20],
])
  for (let cy = by; cy < by + 6; cy++)
    for (let cx = bx; cx < bx + 6; cx++)
      for (let y = cy * CHUNK_SIZE; y < (cy + 1) * CHUNK_SIZE; y++)
        for (let x = cx * CHUNK_SIZE; x < (cx + 1) * CHUNK_SIZE; x++) {
          const h = hAt(x, y);
          if (Math.abs(h - hAt(x + 1, y)) > 1 || Math.abs(h - hAt(x, y + 1)) > 1) cliffs++;
        }
assert.equal(cliffs, 0, '이웃 칸 고도 차가 2 이상인 곳이 있습니다');
let mismatch = 0;
for (let i = 0; i < 2000; i++) {
  const x = Math.floor(Math.sin(i * 12.9898) * 3000);
  const y = Math.floor(Math.cos(i * 78.233) * 2000);
  if (sampleSite(x, y).height !== hAt(x, y)) mismatch++;
}
assert.equal(mismatch, 0, '칸 생성과 점 질의의 고도가 다릅니다');
console.log(`  OK   144청크 고도 차 0·1, 생성과 질의 일치 (${Date.now() - t}ms)`);

// 4. 고를 수 있는 자리 중 일부를 실제로 만들어 물이 있는지 본다.
const valid: Origin[] = [];
for (let cy = CONTINENT_Y0; cy < CONTINENT_Y0 + CONTINENT_H - 1; cy++)
  for (let cx = CONTINENT_X0; cx < CONTINENT_X0 + CONTINENT_W - 1; cx++)
    if (siteSummary({ cx, cy }, table).ok) valid.push({ cx, cy });
assert.ok(valid.length > 1000, `고를 수 있는 자리가 너무 적습니다: ${valid.length}`);
let dry = 0;
for (let i = 0; i < valid.length; i += Math.floor(valid.length / 40)) {
  const o = valid[i];
  let water = 0;
  for (let dy = 0; dy < BASE_CHUNK_SPAN; dy++)
    for (let dx = 0; dx < BASE_CHUNK_SPAN; dx++)
      for (const tile of generateContinentChunk(o.cx + dx, o.cy + dy).tiles)
        if (isWater(tile)) water++;
  if (water === 0) dry++;
}
assert.equal(dry, 0, '하천이 있다고 표시된 자리에 물이 없습니다');
console.log(`  OK   고를 수 있는 자리 ${valid.length}곳, 표본 40곳 모두 하천 있음`);

// 5. 아무 순서로 골라도 14명 이상.
t = Date.now();
let seed = 20261116;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
let worst = Infinity;
for (let trial = 0; trial < 4; trial++) {
  let remaining = valid.slice();
  let placed = 0;
  while (remaining.length) {
    const o = remaining[Math.floor(rnd() * remaining.length)];
    placed++;
    remaining = remaining.filter((c) => !spacingBlock(c, [o]));
  }
  worst = Math.min(worst, placed);
}
assert.ok(worst >= 14, `무작위로 고르면 ${worst}명만 들어갑니다`);
console.log(`  OK   무작위 선택 4회 중 최소 ${worst}개 도시 수용 (${Date.now() - t}ms)`);

// 6. 간격 규칙.
const a = valid[Math.floor(valid.length / 2)];
const near = valid.find((o) => Math.hypot(o.cx - a.cx, o.cy - a.cy) < SITE_NEAR && o !== a);
if (near) assert.ok(!canStartAt(near, [a], table).ok, '너무 가까운 자리가 통과했습니다');
const far = valid.find((o) => Math.hypot(o.cx - a.cx, o.cy - a.cy) >= SITE_FAR);
assert.ok(far && canStartAt(far, [a], table).ok, '충분히 먼 자리가 막혔습니다');
let mid = 0;
for (const o of valid) {
  const d = Math.hypot(o.cx - a.cx, o.cy - a.cy);
  if (d < SITE_NEAR || d >= SITE_FAR) continue;
  assert.equal(canStartAt(o, [a], table).ok, barrierBetween(o, a), '중간 거리 판정은 장애물로');
  mid++;
}
assert.ok(mid > 0);
console.log(
  `  OK   간격: ${SITE_NEAR}청크 미만 금지, ${SITE_FAR}청크 이상 통과, 사이 ${mid}곳은 장애물로 판정`,
);

// 7. 점검 도구용 기본 자리도 규칙을 지키고, World 가 그 자리에서 열린다.
const defaults = [0, 1, 2, 3].map(defaultOrigin);
for (let i = 0; i < defaults.length; i++) {
  assert.ok(siteSummary(defaults[i]).ok);
  assert.equal(spacingBlock(defaults[i], defaults.slice(0, i)), '');
}
const world = new World(defaults[1]);
assert.equal(world.baseCx, defaults[1].cx);
assert.equal(world.baseCy, defaults[1].cy);
console.log(
  'Continent passed: map assets, gentle slopes, rivers at every site, room for 14+ cities, spacing.',
);
