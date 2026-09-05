/**
 * 우측통행 / 코너 / 교차로 충돌 검증기 (개발용, 빌드에 포함되지 않는다)
 *
 *   npx esbuild tools/check/laneCheck.ts --bundle --platform=node --format=esm \
 *     --alias:pixi.js=./tools/check/stub-pixi.ts --outfile=/tmp/laneCheck.mjs
 *   node /tmp/laneCheck.mjs
 *
 * 1) 숫자 검증: 마주 오는 차가 항상 중앙선 반대편에 있는지, 코너에서 위치가 튀지 않는지
 * 2) 그림 검증: /tmp/lane_scene.png, /tmp/vehicle_atlas.png
 */
import { createCanvas } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';
import { TILE_HH, TILE_HW } from '../../src/core/constants';
import { tileToWorldX, tileToWorldY } from '../../src/core/iso';
import {
  LANE_OFFSET_TILES,
  laneFacing,
  laneHeading,
  lanePosition,
  movementsConflict,
} from '../../src/sim/traffic/laneGeometry';
import type { Route } from '../../src/sim/traffic/router';
import { drawPlaceholder, VEHICLE_CELL, VEHICLE_GROUND_DROP_PX } from '../../src/render/vehicleAtlas';

const DIRS: ReadonlyArray<readonly [number, number]> = [[1, 0], [0, 1], [-1, 0], [0, -1]];

function route(points: ReadonlyArray<[number, number]>): Route {
  const flat: number[] = [];
  for (const [x, y] of points) flat.push(x, y);
  return { tiles: Int32Array.from(flat), costAtPlan: 0 };
}

function line(from: [number, number], to: [number, number]): [number, number][] {
  const points: [number, number][] = [];
  const dx = Math.sign(to[0] - from[0]);
  const dy = Math.sign(to[1] - from[1]);
  let [x, y] = from;
  points.push([x, y]);
  while (x !== to[0] || y !== to[1]) {
    if (x !== to[0]) x += dx;
    else y += dy;
    points.push([x, y]);
  }
  return points;
}

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

/* ---------------- 1. 우측통행 ---------------- */

// 같은 도로를 정반대로 달리는 두 경로
for (let d = 0; d < 4; d++) {
  const dir = DIRS[d];
  const opposite = DIRS[(d + 2) & 3];
  const forward = route(line([0, 0], [dir[0] * 8, dir[1] * 8]));
  const backward = route(line([dir[0] * 8, dir[1] * 8], [0, 0]));

  let allRight = true;
  let minSeparation = Infinity;
  for (let s = 0; s <= 60; s++) {
    const t = (s / 60) * 6; // 노드 0~6 구간
    const i = Math.floor(t);
    const u = t - i;
    const a = lanePosition(forward, i, u);
    // 같은 물리 지점에서 반대편 차량 위치
    const b = lanePosition(backward, 8 - i, 1 - u);

    // 중앙선(도로 중심선) 기준 왼/오른쪽. 진행방향의 오른쪽으로 나가 있어야 한다.
    const centreA: [number, number] = [dir[0] * t, dir[1] * t];
    const offA: [number, number] = [a[0] - centreA[0], a[1] - centreA[1]];
    const offB: [number, number] = [b[0] - centreA[0], b[1] - centreA[1]];
    const rightA = DIRS[(d + 1) & 3];
    const rightB = DIRS[(((d + 2) & 3) + 1) & 3];
    const dotA = offA[0] * rightA[0] + offA[1] * rightA[1];
    const dotB = offB[0] * rightB[0] + offB[1] * rightB[1];
    if (dotA < LANE_OFFSET_TILES - 1e-6 || dotB < LANE_OFFSET_TILES - 1e-6) allRight = false;
    minSeparation = Math.min(minSeparation, Math.hypot(a[0] - b[0], a[1] - b[1]));
  }
  check(
    `우측통행 dir=${d} (${dir}) 양방향 모두 진행방향 오른쪽 차선`,
    allRight,
    `마주보는 차 간격 ${minSeparation.toFixed(3)} 타일`,
  );
  check(
    `우측통행 dir=${d} 마주보는 차가 겹치지 않음 (>= 차체폭 0.30)`,
    minSeparation >= 0.3,
  );
}

/* ---------------- 2. 코너 ---------------- */

// 우회전: +tx 로 오다가 +ty 로. 좌회전: +tx 로 오다가 -ty 로.
const rightTurn = route(line([0, 0], [4, 0]).concat(line([4, 1], [4, 4])));
const leftTurn = route(line([0, 0], [4, 0]).concat(line([4, -1], [4, -4])));

for (const [name, r] of [['우회전', rightTurn], ['좌회전', leftTurn]] as const) {
  let maxStep = 0;
  let prev: [number, number] | null = null;
  const samples = 400;
  for (let s = 0; s <= samples; s++) {
    const t = (s / samples) * (r.tiles.length / 2 - 1);
    const i = Math.floor(t);
    const p = lanePosition(r, i, t - i);
    if (prev) maxStep = Math.max(maxStep, Math.hypot(p[0] - prev[0], p[1] - prev[1]));
    prev = p;
  }
  const idealStep = (r.tiles.length / 2 - 1) / samples;
  check(
    `${name} 궤적이 연속 (위치가 튀지 않음)`,
    maxStep < idealStep * 3,
    `최대 한 걸음 ${maxStep.toFixed(4)} / 이상값 ${idealStep.toFixed(4)}`,
  );
}

// 우회전은 안쪽(짧게), 좌회전은 바깥쪽(넓게) 돌아야 한다.
function pathLength(r: Route): number {
  let total = 0;
  let prev: [number, number] | null = null;
  const samples = 2000;
  for (let s = 0; s <= samples; s++) {
    const t = (s / samples) * (r.tiles.length / 2 - 1);
    const i = Math.floor(t);
    const p = lanePosition(r, i, t - i);
    if (prev) total += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    prev = p;
  }
  return total;
}
const lenRight = pathLength(rightTurn);
const lenLeft = pathLength(leftTurn);
check(
  '우회전이 좌회전보다 짧다 (안쪽으로 돈다)',
  lenRight < lenLeft,
  `우 ${lenRight.toFixed(3)} < 좌 ${lenLeft.toFixed(3)}`,
);

// 코너에서 스프라이트 방향이 진입 -> 진출로 실제로 바뀌는지
const facings = new Set<number>();
for (let s = 0; s <= 200; s++) {
  const t = (s / 200) * (rightTurn.tiles.length / 2 - 1);
  const i = Math.floor(t);
  facings.add(laneFacing(rightTurn, i, t - i));
}
check('우회전 중 스프라이트 방향이 진입/진출 두 방향을 모두 쓴다', facings.has(0) && facings.has(1));

// 접선이 항상 단위벡터인지
let headingOk = true;
for (let s = 0; s <= 200; s++) {
  const t = (s / 200) * (leftTurn.tiles.length / 2 - 1);
  const i = Math.floor(t);
  const h = laneHeading(leftTurn, i, t - i);
  if (Math.abs(Math.hypot(h[0], h[1]) - 1) > 1e-6) headingOk = false;
}
check('접선이 단위벡터', headingOk);

/* ---------------- 3. 교차로 충돌 ---------------- */

const S = (d: number) => d; // 직진
const R = (d: number) => (d + 1) & 3; // 우회전
const L = (d: number) => (d + 3) & 3; // 좌회전

check('마주 오는 직진끼리는 통과', !movementsConflict(0, S(0), 2, S(2)));
check('마주 오는 좌회전끼리는 통과', !movementsConflict(0, L(0), 2, L(2)));
check('마주 오는 우회전끼리는 통과', !movementsConflict(0, R(0), 2, R(2)));
check('직교 직진끼리는 충돌', movementsConflict(0, S(0), 1, S(1)));
check('좌회전과 마주 오는 직진은 충돌', movementsConflict(0, L(0), 2, S(2)));
check('좌회전과 마주 오는 우회전은 같은 차선으로 합류 -> 충돌', movementsConflict(0, L(0), 2, R(2)));
check('같은 방향에서 들어오면 예약이 아니라 줄서기 (충돌 아님)', !movementsConflict(0, S(0), 0, R(0)));
// L자 굽은 길: 한쪽은 우회전, 반대쪽은 좌회전이지만 차선이 달라 서로 막지 않아야 한다.
check('L자 코너에서 양방향이 서로 막지 않음', !movementsConflict(0, 1, 3, 2));

/* ---------------- 4. 그림 ---------------- */

const atlasCanvas = createCanvas(256, 64);
const atlasCtx = atlasCanvas.getContext('2d');
drawPlaceholder(atlasCtx as unknown as CanvasRenderingContext2D);
const zoom = 6;
const bigAtlas = createCanvas(256 * zoom, 64 * zoom + 30);
const bigCtx = bigAtlas.getContext('2d');
bigCtx.fillStyle = '#2c3138';
bigCtx.fillRect(0, 0, bigAtlas.width, bigAtlas.height);
bigCtx.imageSmoothingEnabled = false;
bigCtx.drawImage(atlasCanvas, 0, 30, 256 * zoom, 64 * zoom);
bigCtx.fillStyle = '#fff';
bigCtx.font = '18px sans-serif';
const dirNames = ['+tx (RD)', '+ty (LD)', '-tx (LU)', '-ty (RU)'];
for (let d = 0; d < 4; d++) {
  bigCtx.fillText(dirNames[d], d * 2 * VEHICLE_CELL * zoom + 8, 22);
}
writeFileSync('/tmp/vehicle_atlas.png', bigAtlas.toBuffer('image/png'));

// 도로망 + 차선 + 차량
const scene = createCanvas(1100, 720);
const ctx = scene.getContext('2d');
ctx.fillStyle = '#20262c';
ctx.fillRect(0, 0, scene.width, scene.height);
const originX = 560;
const originY = 120;
const toScreen = (tx: number, ty: number): [number, number] => [
  originX + tileToWorldX(tx, ty),
  originY + tileToWorldY(tx, ty, 0),
];

const roadTiles = new Set<string>();
const addRoad = (pts: ReadonlyArray<[number, number]>) => {
  for (const [x, y] of pts) roadTiles.add(`${x},${y}`);
};
addRoad(line([0, 6], [12, 6]));
addRoad(line([6, 0], [6, 12]));
addRoad(line([0, 12], [12, 12]));
addRoad(line([12, 6], [12, 12]));

for (const key of roadTiles) {
  const [x, y] = key.split(',').map(Number);
  const c = toScreen(x, y);
  ctx.fillStyle = '#43494f';
  ctx.beginPath();
  ctx.moveTo(c[0], c[1] - TILE_HH);
  ctx.lineTo(c[0] + TILE_HW, c[1]);
  ctx.lineTo(c[0], c[1] + TILE_HH);
  ctx.lineTo(c[0] - TILE_HW, c[1]);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#33383d';
  ctx.stroke();
}

// 도로 중앙선(노란 점선)
ctx.strokeStyle = '#c9a227';
ctx.setLineDash([6, 6]);
ctx.lineWidth = 1;
for (const [a, b] of [
  [[0, 6], [12, 6]],
  [[6, 0], [6, 12]],
  [[0, 12], [12, 12]],
  [[12, 6], [12, 12]],
] as [number, number][][]) {
  const p0 = toScreen(a[0], a[1]);
  const p1 = toScreen(b[0], b[1]);
  ctx.beginPath();
  ctx.moveTo(p0[0], p0[1]);
  ctx.lineTo(p1[0], p1[1]);
  ctx.stroke();
}
ctx.setLineDash([]);

const scenarios: Array<{ r: Route; color: string; label: string }> = [
  { r: route(line([0, 6], [12, 6])), color: '#63b3ed', label: '동쪽으로 (+tx)' },
  { r: route(line([12, 6], [0, 6])), color: '#f6ad55', label: '서쪽으로 (-tx)' },
  { r: route(line([6, 0], [6, 12])), color: '#68d391', label: '남쪽으로 (+ty)' },
  { r: route(line([6, 12], [6, 0])), color: '#fc8181', label: '북쪽으로 (-ty)' },
  { r: route(line([12, 6], [12, 12]).concat(line([11, 12], [0, 12]))), color: '#d6bcfa', label: '우회전 경로' },
  { r: route(line([0, 12], [12, 12]).concat(line([12, 11], [12, 6]))), color: '#f687b3', label: '좌회전 경로' },
];

for (const { r, color } of scenarios) {
  const points = r.tiles.length / 2;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let s = 0; s <= 600; s++) {
    const t = (s / 600) * (points - 1);
    const i = Math.floor(t);
    const p = lanePosition(r, i, t - i);
    const sc = toScreen(p[0], p[1]);
    if (s === 0) ctx.moveTo(sc[0], sc[1]);
    else ctx.lineTo(sc[0], sc[1]);
  }
  ctx.stroke();

  // 차량을 일정 간격으로 얹는다
  for (let s = 1; s < 8; s++) {
    const t = (s / 8) * (points - 1);
    const i = Math.floor(t);
    const p = lanePosition(r, i, t - i);
    const facing = laneFacing(r, i, t - i);
    const sc = toScreen(p[0], p[1]);
    ctx.drawImage(
      atlasCanvas,
      facing * 2 * VEHICLE_CELL, 0, VEHICLE_CELL, VEHICLE_CELL,
      sc[0] - VEHICLE_CELL / 2, sc[1] - VEHICLE_CELL / 2 - VEHICLE_GROUND_DROP_PX, VEHICLE_CELL, VEHICLE_CELL,
    );
  }
}

ctx.font = '14px sans-serif';
let ly = 24;
for (const { color, label } of scenarios) {
  ctx.fillStyle = color;
  ctx.fillRect(16, ly - 10, 12, 12);
  ctx.fillStyle = '#e2e8f0';
  ctx.fillText(label, 34, ly);
  ly += 20;
}
ctx.fillStyle = '#e2e8f0';
ctx.fillText('yellow dashed = road centre line', 16, ly + 6);

writeFileSync('/tmp/lane_scene.png', scene.toBuffer('image/png'));

// 교차로 주변 확대. 마주 오는 차가 중앙선을 사이에 두고 갈라지는지 눈으로 본다.
const zoomCanvas = createCanvas(1100, 720);
const zc = zoomCanvas.getContext('2d');
zc.imageSmoothingEnabled = false;
zc.fillStyle = '#20262c';
zc.fillRect(0, 0, 1100, 720);
zc.drawImage(scene, 340, 168, 440, 288, 0, 0, 1100, 720);
writeFileSync('/tmp/lane_zoom.png', zoomCanvas.toBuffer('image/png'));
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
