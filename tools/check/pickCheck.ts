import { strict as assert } from 'node:assert';
import { CHUNK_SIZE, HEIGHT_UNIT, TILE_HH, TILE_HW } from '../../src/core/constants';
import { tileToWorldX, tileToWorldY } from '../../src/core/iso';
import { pickTile } from '../../src/core/pick';
import { Build } from '../../src/world/build';
import { World } from '../../src/world/world';

/**
 * 타일 집기(pick) 판정 검사.
 *
 * 핵심은 "화면에 보이는 그림과 집히는 타일이 같은가" 다. 특히 절벽 옆면은
 * 예전 판정에서 통째로 구멍이었다 — 바닥을 드래그하다 그 바닥의 옆면에 닿으면
 * 커서가 몇 칸 뒤(화면 위)로 튀었다.
 */

const world = new World(0);
const tx0 = world.baseCx * CHUNK_SIZE + 20;
const ty0 = world.baseCy * CHUNK_SIZE + 20;

// 시험용 지형: 평지 한복판에 2단 높이의 3x3 대지를 올린다.
for (let dy = -8; dy <= 8; dy++)
  for (let dx = -8; dx <= 8; dx++) {
    world.setHeight(tx0 + dx, ty0 + dy, 0);
    world.setBuild(tx0 + dx, ty0 + dy, Build.None);
  }
const PLATEAU = 2;
for (let dy = 0; dy <= 2; dy++)
  for (let dx = 0; dx <= 2; dx++) world.setHeight(tx0 + dx, ty0 + dy, PLATEAU);

const at = (tx: number, ty: number, h: number, ox = 0, oy = 0): { wx: number; wy: number } => ({
  wx: tileToWorldX(tx, ty) + ox,
  wy: tileToWorldY(tx, ty, h) + oy,
});

const expectTile = (p: { wx: number; wy: number }, tx: number, ty: number, what: string): void => {
  const got = pickTile(world, p.wx, p.wy);
  assert.deepEqual(got, { tx, ty }, `${what}: expected ${tx},${ty} got ${got.tx},${got.ty}`);
};

/* ---------- 평지: 예전과 같은 답이 나와야 한다 ---------- */
for (let dy = -6; dy <= -4; dy++)
  for (let dx = -6; dx <= -4; dx++) {
    const t = { tx: tx0 + dx, ty: ty0 + dy };
    expectTile(at(t.tx, t.ty, 0), t.tx, t.ty, '평지 중심');
    expectTile(at(t.tx, t.ty, 0, TILE_HW - 2, 0), t.tx, t.ty, '평지 오른쪽 끝');
    expectTile(at(t.tx, t.ty, 0, 0, TILE_HH - 2), t.tx, t.ty, '평지 아래 끝');
  }

/* ---------- 대지 윗면 ---------- */
for (let dy = 0; dy <= 2; dy++)
  for (let dx = 0; dx <= 2; dx++)
    expectTile(at(tx0 + dx, ty0 + dy, PLATEAU), tx0 + dx, ty0 + dy, '대지 윗면');

/* ---------- 이번 버그: 대지 옆면 ---------- */
/*
 * 앞 가장자리 타일의 +tx 옆면 한복판. 옆면 위쪽은 예전 판정이 고도 0 평면으로
 * 떨어지면서 한 칸 뒤(tx0+2, ty0) 를 골랐고, 커서가 대지 위로 튀어 올랐다.
 */
const edge = { tx: tx0 + 2, ty: ty0 + 1 };
const base = tileToWorldY(edge.tx, edge.ty);
for (const dy of [-20, -12, -4, 4]) {
  expectTile(
    { wx: tileToWorldX(edge.tx, edge.ty) + TILE_HW / 2, wy: base + dy },
    edge.tx,
    edge.ty,
    `+tx 옆면 (y=base${dy})`,
  );
}

// 같은 자리의 +ty 옆면(왼쪽 아래를 향한 면).
const side = { tx: tx0 + 1, ty: ty0 + 2 };
const sideBase = tileToWorldY(side.tx, side.ty);
for (const dy of [-20, -12, -4, 4]) {
  expectTile(
    { wx: tileToWorldX(side.tx, side.ty) - TILE_HW / 2, wy: sideBase + dy },
    side.tx,
    side.ty,
    `+ty 옆면 (y=base${dy})`,
  );
}

// 옆면 바로 아래, 앞 타일의 윗면이 옆면을 가리는 자리는 앞 타일이어야 한다.
expectTile(
  { wx: tileToWorldX(edge.tx, edge.ty) + TILE_HW / 2, wy: base + 14 },
  edge.tx + 1,
  edge.ty,
  '옆면을 가린 앞 타일 윗면',
);

/* ---------- 커서가 뒤로 튀지 않는다 ---------- */
/*
 * 화면에서 아래로 훑으면 집히는 타일은 점점 앞(= tx + ty 가 큰 쪽)으로만 가야
 * 한다. 한 번이라도 뒤로 돌아가면 그게 "커서가 위로 튀는" 증상이다.
 */
let sweeps = 0;
for (let ox = -TILE_HW + 1; ox < TILE_HW; ox += 3) {
  let depth = -Infinity;
  let last = '';
  for (let wy = tileToWorldY(tx0, ty0, PLATEAU + 2); wy < tileToWorldY(tx0 + 6, ty0 + 6); wy++) {
    const t = pickTile(world, tileToWorldX(tx0 + 1, ty0 + 1) + ox, wy);
    const d = t.tx + t.ty;
    assert.ok(
      d >= depth,
      `아래로 훑는 중 커서가 뒤로 튐: ox=${ox} wy=${wy} ${last} -> ${t.tx},${t.ty}`,
    );
    depth = d;
    last = `${t.tx},${t.ty}`;
    sweeps++;
  }
}

/* ---------- 경사 도로 위에서도 노면을 따라간다 ---------- */
/*
 * 0-1-2 로 곧게 오르는 비탈길. 램프면은 평평한 마름모가 아니라 기운 평행사변형이라
 * 고도만 보고 판정하면 이음매에서 한 칸씩 어긋난다.
 */
const rx = tx0 - 5;
for (let i = 0; i <= 2; i++) {
  world.setHeight(rx + i, ty0, i);
  world.setBuild(rx + i, ty0, Build.Road);
}
for (let i = 0; i <= 2; i++) {
  const t = pickTile(
    world,
    tileToWorldX(rx + i, ty0),
    tileToWorldY(rx + i, ty0, i) - HEIGHT_UNIT / 4,
  );
  assert.ok(
    Math.abs(t.tx - (rx + i)) + Math.abs(t.ty - ty0) <= 1,
    `비탈길 ${i} 칸: ${t.tx},${t.ty}`,
  );
}

console.log(`pick ok — 옆면/윗면 판정, 훑기 ${sweeps} 지점`);
