import { FACILITY_SPAN } from '../sim/config/facilities';
import { MATERIAL as M, PixelArt, type Material, type PixelColor } from './pixelArt';

function office(
  a: PixelArt,
  u: number,
  v: number,
  w: number,
  d: number,
  h: number,
  m: Material,
): void {
  a.box(u, v, w, d, h, m);
  a.windows(u, v, w, d, h);
  a.slab(u + 0.06, v + 0.06, w - 0.12, d - 0.12, h + 1, 'roof');
  if (w > 1 && d > 0.6) {
    for (let t = 0.45; t < w - 0.15; t += 0.45)
      a.line(a.p(u + t, v + 0.08, h + 1), a.p(u + t, v + d - 0.08, h + 1), 'roofDark');
    a.box(u + 0.15, v + 0.15, 0.26, 0.18, 3, M.steel, h + 1);
    const p = a.p(u + 0.28, v + 0.23, h + 5);
    a.rect(p[0] - 2, p[1] - 1, 4, 2, 'roofDark');
  }
  a.door(u + w / 2, v + d);
}
function chimney(a: PixelArt, u: number, v: number, h: number): void {
  a.box(u, v, 0.16, 0.16, h, M.steel);
  for (let z = 9; z < h; z += 9) a.box(u - 0.01, v - 0.01, 0.18, 0.18, 3, M.red, z);
  a.slab(u + 0.02, v + 0.02, 0.12, 0.12, h + 1, 'ink');
}
function basin(a: PixelArt, u: number, v: number, w: number, d: number, dirty = false): void {
  a.box(u, v, w, d, 3, M.steel);
  a.slab(u + 0.05, v + 0.05, w - 0.1, d - 0.1, 4, dirty ? 'soil' : 'water', 'ink');
  a.line(
    a.p(u + 0.12, v + 0.12, 5),
    a.p(u + w - 0.12, v + 0.12, 5),
    dirty ? 'woodLight' : 'waterLight',
  );
}
function crane(a: PixelArt, u: number, v: number): void {
  a.box(u, v, 0.12, 0.12, 32, M.yellow);
  a.box(u - 0.25, v, 0.85, 0.12, 3, M.yellow, 30);
  a.line(a.p(u + 0.57, v + 0.06, 30), a.p(u + 0.57, v + 0.06, 9), 'ink');
  a.box(u - 0.09, v - 0.02, 0.25, 0.22, 5, M.blue, 24);
  a.line(a.p(u, v, 30), a.p(u + 0.4, v, 32), 'paper');
}
function fence(a: PixelArt, n: number): void {
  for (let t = 0.15; t <= n - 0.1; t += 0.25) {
    a.line(a.p(t, n - 0.12), a.p(t, n - 0.12, 7), 'ink');
    a.line(a.p(n - 0.12, t), a.p(n - 0.12, t, 7), 'ink');
  }
  for (const z of [3, 6]) {
    a.line(a.p(0.15, n - 0.12, z), a.p(n - 0.12, n - 0.12, z), 'stone');
    a.line(a.p(n - 0.12, 0.15, z), a.p(n - 0.12, n - 0.12, z), 'stone');
  }
}
function treeRow(a: PixelArt, n: number): void {
  for (let t = 0.25; t < n - 0.2; t += 0.55) a.tree(t, n - 0.3);
}
function solar(a: PixelArt, u: number, v: number): void {
  a.box(u, v, 0.65, 0.4, 4, M.blue);
  a.slab(u + 0.03, v + 0.03, 0.59, 0.34, 5, 'blueDark');
  for (let x = 0.16; x < 0.65; x += 0.16)
    a.line(a.p(u + x, v + 0.03, 5), a.p(u + x, v + 0.37, 5), 'glass');
  a.line(a.p(u + 0.03, v + 0.2, 5), a.p(u + 0.62, v + 0.2, 5), 'glassLight');
}

/* ---------------- 식량 시설 (27~35) ---------------- */

function cropField(
  a: PixelArt,
  u: number,
  v: number,
  w: number,
  d: number,
  base: PixelColor,
  row: PixelColor,
): void {
  a.slab(u, v, w, d, 0, base, 'soil');
  for (let t = v + 0.12; t < v + d - 0.05; t += 0.16)
    a.line(a.p(u + 0.05, t), a.p(u + w - 0.05, t), row);
}
function barn(a: PixelArt, u: number, v: number, w: number, d: number, h: number): void {
  a.box(u, v, w, d, h, M.red);
  a.gable(u - 0.03, v - 0.03, w + 0.06, d + 0.06, h, M.roof);
  const door = a.p(u + w / 2, v + d, 0);
  a.rect(door[0] - 3, door[1] - 9, 6, 9, 'redDark');
  a.line([door[0] - 3, door[1] - 9], [door[0] + 3, door[1]], 'white');
  a.line([door[0] + 3, door[1] - 9], [door[0] - 3, door[1]], 'white');
}
function silo(a: PixelArt, u: number, v: number, h: number): void {
  a.box(u, v, 0.3, 0.3, h, M.steel);
  a.slab(u + 0.03, v + 0.03, 0.24, 0.24, h + 2, 'stone', 'stoneDark');
  for (let z = 6; z < h; z += 6) a.line(a.p(u, v + 0.3, z), a.p(u + 0.3, v + 0.3, z), 'stoneDark');
}
function animal(a: PixelArt, u: number, v: number, body: PixelColor, spot: PixelColor): void {
  const p = a.p(u, v, 2);
  a.rect(p[0] - 3, p[1] - 3, 6, 3, body);
  a.dot(p[0] + 3, p[1] - 4, body);
  a.dot(p[0] - 1, p[1] - 3, spot);
  a.dot(p[0] - 3, p[1], 'ink');
  a.dot(p[0] + 2, p[1], 'ink');
}
function longShed(a: PixelArt, u: number, v: number, w: number, d: number, m: Material): void {
  a.box(u, v, w, d, 8, m);
  a.gable(u - 0.02, v - 0.02, w + 0.04, d + 0.04, 8, M.roof);
  for (let t = u + 0.2; t < u + w - 0.1; t += 0.3) {
    const p = a.p(t, v + d, 4);
    a.rect(p[0] - 1, p[1] - 2, 3, 2, 'glassDark');
  }
}
function glasshouse(a: PixelArt, u: number, v: number, w: number, d: number): void {
  a.box(u, v, w, d, 9, M.glass);
  a.gable(u, v, w, d, 9, M.glass);
  for (let t = u + 0.15; t < u + w; t += 0.18)
    a.line(a.p(t, v + d, 0), a.p(t, v + d, 9), 'glassLight');
  a.slab(u + 0.05, v + 0.05, w - 0.1, d - 0.1, 1, 'leafLight');
}

function foodArt(a: PixelArt, kind: number, n: number): void {
  if (kind === 27) {
    // 곡물 농장: 누런 밀밭 셋, 붉은 헛간, 사일로 둘.
    cropField(a, 0.15, 0.15, 2.3, 2.1, 'yellow', 'yellowDark');
    cropField(a, 0.15, 2.4, 2.3, 2.4, 'yellowLight', 'yellow');
    cropField(a, 2.6, 2.4, 2.25, 2.4, 'leafLight', 'leaf');
    barn(a, 2.75, 0.25, 1.2, 0.8, 14);
    silo(a, 4.15, 0.3, 26);
    silo(a, 4.15, 0.85, 22);
    a.slab(2.6, 1.3, 2.2, 0.9, 0, 'soil');
    a.box(3.2, 1.55, 0.35, 0.22, 4, M.yellow);
  } else if (kind === 28) {
    cropField(a, 0.15, 0.15, n - 0.3, 1.6, 'soil', 'leaf');
    cropField(a, 0.15, 1.85, 1.6, n - 2, 'soil', 'leafLight');
    a.box(2, 2, 0.75, 0.6, 9, M.wood);
    a.gable(1.98, 1.98, 0.79, 0.64, 9, M.roof);
  } else if (kind === 29) {
    a.slab(0.1, 0.1, n - 0.2, n - 0.2, 0, 'grassDark');
    for (let v = 0.45; v < n - 0.2; v += 0.7)
      for (let u = 0.45; u < n - 0.2; u += 0.7) a.tree(u, v);
    a.box(0.15, n - 0.5, 0.4, 0.3, 6, M.wood);
  } else if (kind === 30) {
    // 목장: 울타리 친 풀밭과 소, 헛간.
    a.slab(0.1, 0.1, n - 0.2, n - 0.2, 0, 'grassLight', 'grassDark');
    fence(a, n);
    barn(a, 0.35, 0.3, 1.4, 0.95, 15);
    silo(a, 1.95, 0.35, 22);
    a.box(3.4, 0.5, 1, 0.25, 3, M.wood);
    for (const [u, v] of [
      [1.2, 2.2],
      [2.1, 2.7],
      [3.2, 2],
      [2.8, 3.6],
      [1.6, 3.8],
      [3.9, 3.1],
    ])
      animal(a, u, v, (u * 10) % 2 < 1 ? 'white' : 'woodLight', 'ink');
  } else if (kind === 31) {
    longShed(a, 0.25, 0.3, 2.4, 0.6, M.cream);
    longShed(a, 0.25, 1.25, 2.4, 0.6, M.cream);
    silo(a, 2.35, 2.25, 18);
    for (const [u, v] of [
      [0.6, 2.4],
      [1, 2.6],
      [1.4, 2.35],
    ])
      animal(a, u, v, 'white', 'red');
  } else if (kind === 32) {
    glasshouse(a, 0.2, 0.25, 1.15, 1.1);
    glasshouse(a, 1.6, 0.25, 1.15, 1.1);
    glasshouse(a, 0.2, 1.6, 1.15, 1.1);
    a.box(1.65, 1.7, 0.6, 0.5, 10, M.cream);
    a.box(2.4, 1.9, 0.3, 0.3, 14, M.steel);
  } else if (kind === 33) {
    // 어업 기지: 나무 부두와 고깃배, 생선 창고.
    a.slab(0.1, 0.1, n - 0.2, n - 0.2, 0, 'paving', 'pavingDark');
    a.slab(1.05, 0.1, 0.85, 1.8, 1, 'woodLight', 'wood');
    for (let v = 0.25; v < 1.9; v += 0.2) a.line(a.p(1.05, v, 1), a.p(1.9, v, 1), 'wood');
    a.box(0.25, 0.3, 0.7, 0.8, 11, M.blue);
    a.gable(0.23, 0.28, 0.74, 0.84, 11, M.roof);
    a.box(1.3, 1.3, 0.45, 0.25, 4, M.red);
    a.line(a.p(1.5, 1.4, 4), a.p(1.5, 1.4, 16), 'ink');
    a.box(0.25, 1.35, 0.3, 0.3, 4, M.wood);
  } else if (kind === 34) {
    silo(a, 0.3, 0.3, 30);
    silo(a, 0.8, 0.3, 30);
    silo(a, 0.3, 0.85, 26);
    a.box(1.05, 0.95, 0.75, 0.75, 10, M.wood);
    a.gable(1.03, 0.93, 0.79, 0.79, 10, M.roof);
  } else if (kind === 35) {
    office(a, 0.2, 0.25, 1.6, 1.1, 16, M.cream);
    chimney(a, 2.1, 0.4, 34);
    for (const u of [2.05, 2.5]) {
      a.box(u, 1, 0.35, 0.35, 14, M.steel);
      a.slab(u + 0.03, 1.03, 0.29, 0.29, 15, 'stone', 'stoneDark');
    }
    a.box(0.3, 1.75, 0.5, 0.3, 5, M.blue);
    a.box(1, 1.75, 0.5, 0.3, 5, M.yellow);
  }
}

/* ---------------- 자원 시설 (36~47) ---------------- */

const DARK: Material = ['stone', 'stoneDark', 'ink'];

/** 광산 갱구 위의 권양탑(철골 탑 + 바퀴). w = 다리 폭(칸), h = 높이(px). */
function headframe(a: PixelArt, u: number, v: number, w: number, h: number): void {
  a.box(u, v, w, w, 4, M.steel);
  for (const [du, dv] of [
    [0, 0],
    [w, 0],
    [0, w],
    [w, w],
  ])
    a.line(a.p(u + du, v + dv, 4), a.p(u + w / 2, v + w / 2, h), 'stoneDark');
  for (let z = 10; z < h - 6; z += 8)
    a.line(
      a.p(u + (w * z) / (2 * h), v + w - (w * z) / (2 * h), z),
      a.p(u + w - (w * z) / (2 * h), v + w - (w * z) / (2 * h), z),
      'stone',
    );
  a.box(u + w * 0.3, v + w * 0.3, w * 0.4, w * 0.4, 6, M.red, h - 6);
  const c = a.p(u + w / 2, v + w / 2, h + 4);
  a.rect(c[0] - 5, c[1] - 5, 10, 10, 'ink');
  a.rect(c[0] - 3, c[1] - 3, 6, 6, 'stoneDark');
  a.dot(c[0], c[1], 'yellow');
}
function orePile(
  a: PixelArt,
  u: number,
  v: number,
  w: number,
  top: PixelColor,
  side: PixelColor,
): void {
  const l = a.p(u, v + w);
  const f = a.p(u + w, v + w);
  const r = a.p(u + w, v);
  const peak = a.p(u + w * 0.55, v + w * 0.55, w * 16);
  a.poly([l, peak, f], side, 'ink');
  a.poly([f, peak, r], top, 'ink');
}
function pumpjack(a: PixelArt, u: number, v: number, s = 1): void {
  a.slab(u, v, 0.7 * s, 0.35 * s, 1, 'pavingDark', 'ink');
  // A자 받침대
  a.line(a.p(u + 0.25 * s, v + 0.05 * s, 1), a.p(u + 0.35 * s, v + 0.17 * s, 16 * s), 'ink');
  a.line(a.p(u + 0.45 * s, v + 0.3 * s, 1), a.p(u + 0.35 * s, v + 0.17 * s, 16 * s), 'ink');
  // 빔과 말머리
  a.line(
    a.p(u + 0.02, v + 0.17 * s, 13 * s),
    a.p(u + 0.68 * s, v + 0.17 * s, 19 * s),
    'yellowDark',
  );
  a.line(a.p(u + 0.02, v + 0.18 * s, 12 * s), a.p(u + 0.68 * s, v + 0.18 * s, 18 * s), 'yellow');
  const head = a.p(u + 0.02, v + 0.17 * s, 12 * s);
  a.rect(head[0] - 3, head[1] - 2, 4, 8, 'yellow');
  a.line(a.p(u + 0.04, v + 0.17 * s, 10 * s), a.p(u + 0.04, v + 0.17 * s, 1), 'ink');
  // 평형추
  const crank = a.p(u + 0.6 * s, v + 0.17 * s, 8 * s);
  a.rect(crank[0] - 3, crank[1] - 3, 6, 6, 'redDark');
}
function tank(
  a: PixelArt,
  u: number,
  v: number,
  w: number,
  h: number,
  m: Material = M.cream,
): void {
  a.box(u, v, w, w, h, m);
  a.slab(u + 0.03, v + 0.03, w - 0.06, w - 0.06, h + 1, 'paper', 'stone');
  a.line(a.p(u, v + w, h * 0.5), a.p(u + w, v + w, h * 0.5), 'stoneDark');
  a.line(a.p(u + w, v, h * 0.5), a.p(u + w, v + w, h * 0.5), 'stoneDark');
}
function coolingTower(a: PixelArt, u: number, v: number, w: number, h: number): void {
  a.box(u, v, w, w, h * 0.6, M.steel);
  a.box(u + w * 0.08, v + w * 0.08, w * 0.84, w * 0.84, h * 0.4, M.steel, h * 0.6);
  a.slab(u + w * 0.12, v + w * 0.12, w * 0.76, w * 0.76, h + 1, 'stoneDark', 'ink');
  a.line(a.p(u, v + w, h * 0.3), a.p(u + w, v + w, h * 0.3), 'stoneDark');
}
function conveyor(
  a: PixelArt,
  u0: number,
  v0: number,
  z0: number,
  u1: number,
  v1: number,
  z1: number,
): void {
  a.line(a.p(u0, v0, z0), a.p(u1, v1, z1), 'ink');
  a.line(a.p(u0, v0, z0 + 2), a.p(u1, v1, z1 + 2), 'yellowDark');
}

function resourceArt(a: PixelArt, kind: number, n: number): void {
  const tier = kind <= 38 ? 1 : kind <= 41 ? 2 : kind <= 44 ? 3 : 0;
  const res = kind <= 44 ? (kind - 36) % 3 : -1; // 0 철, 1 석탄, 2 석유
  if (tier > 0) {
    a.slab(0.12, 0.12, n - 0.24, n - 0.24, 0, res === 1 ? 'pavingDark' : 'soil', 'shadow');
    if (res === 2) {
      // 유정: 펌프잭 줄 + 저장 탱크(+ 3단계는 처리 설비)
      const rows =
        tier === 1
          ? [
              [0.25, 0.3],
              [1.3, 0.3],
              [0.25, 1.25],
            ]
          : [];
      if (tier >= 2)
        for (let y = 0.3; y < n - 2.2; y += 1.2)
          for (let x = 0.3; x < n - 2.4; x += 1.25) rows.push([x, y]);
      for (const [x, y] of rows) pumpjack(a, x, y, tier === 1 ? 1 : 1.25);
      const tw = tier === 1 ? 0.9 : 1.3;
      tank(a, n - tw - 0.25, n - tw - 0.25, tw, 16 + tier * 4);
      if (tier >= 2) tank(a, n - tw * 2 - 0.45, n - tw - 0.25, tw, 14 + tier * 4);
      if (tier === 3) {
        tank(a, n - tw - 0.25, n - tw * 2 - 0.45, tw, 18);
        office(a, 0.35, n - 1.5, 1.8, 1.1, 14, M.blue);
        chimney(a, 2.5, n - 1.3, 40);
      }
      return;
    }
    const top: PixelColor = res === 0 ? 'brickLight' : 'stoneDark';
    const side: PixelColor = res === 0 ? 'brickDark' : 'ink';
    const hall = res === 0 ? M.brick : M.steel;
    // 권양탑 + 선광장 + 광석 더미. 단계가 오를수록 탑·더미가 늘고 커진다.
    const hw = 0.55 + tier * 0.12;
    const hh = 34 + tier * 12;
    headframe(a, 0.35, 0.35, hw, hh);
    const bw = Math.min(n - 1.6, 1.1 + tier * 0.5);
    a.box(0.45 + hw + 0.2, 0.3, bw, 0.9, 12 + tier * 3, hall);
    a.gable(0.43 + hw + 0.2, 0.28, bw + 0.04, 0.94, 12 + tier * 3, M.roof);
    a.windows(0.45 + hw + 0.2, 0.3, bw, 0.9, 12 + tier * 3);
    const pile = 0.95 + tier * 0.25;
    orePile(a, 0.3, n - pile - 0.3, pile, top, side);
    conveyor(a, 0.3 + pile * 0.55, n - pile * 0.45 - 0.3, pile * 14, 0.35 + hw / 2, 0.35 + hw, 20);
    if (tier >= 2) {
      headframe(a, n - hw - 0.4, 0.4, hw, hh - 6);
      orePile(a, n - pile - 0.35, n - pile - 0.35, pile, top, side);
      a.box(n - 2.2, n - 2.6, 1.0, 0.7, 10, M.steel);
    }
    if (tier === 3) {
      orePile(a, n / 2 - pile / 2, n - pile - 0.3, pile * 0.9, top, side);
      a.box(2.4, 2.2, 1.6, 1.2, 16, hall);
      a.gable(2.38, 2.18, 1.64, 1.24, 16, M.roof);
      chimney(a, 4.3, 2.4, 44);
      conveyor(a, 3.2, 2.8, 16, n - 0.9, n - 0.9, 18);
    }
    return;
  }
  a.slab(0.12, 0.12, n - 0.24, n - 0.24, 0, kind === 46 ? 'paving' : 'pavingDark', 'shadow');
  if (kind === 45) {
    // 제철소: 고로(높은 탑) + 열풍로 3기 + 굴뚝 2개 + 압연 공장 + 철광석 더미
    a.box(1.7, 1.2, 1.1, 1.1, 46, M.brick);
    a.box(1.85, 1.35, 0.8, 0.8, 8, DARK, 46);
    a.box(1.95, 1.45, 0.6, 0.6, 6, M.steel, 54);
    for (const u of [0.3, 0.75, 1.2]) {
      a.box(u, 0.35, 0.38, 0.38, 34, M.steel);
      a.slab(u + 0.04, 0.39, 0.3, 0.3, 35, 'stone', 'stoneDark');
    }
    chimney(a, 3.6, 0.4, 58);
    chimney(a, 4.1, 0.85, 50);
    longShed(a, 0.3, 3.1, 2.8, 1.5, M.steel);
    orePile(a, 3.3, 3.1, 1.4, 'brickLight', 'brickDark');
    conveyor(a, 3.9, 3.6, 16, 2.4, 1.6, 44);
    return;
  }
  if (kind === 46) {
    // 정유소: 증류탑 3기 + 굴뚝 + 둥근 탱크 6기 + 배관
    for (const [u, v, h] of [
      [0.4, 0.35, 56],
      [1.05, 0.45, 44],
      [0.55, 1.15, 34],
    ] as const) {
      a.box(u, v, 0.45, 0.45, h, M.steel);
      for (let z = 6; z < h; z += 7)
        a.line(a.p(u, v + 0.45, z), a.p(u + 0.45, v + 0.45, z), 'stoneDark');
      a.slab(u + 0.04, v + 0.04, 0.37, 0.37, h + 1, 'stone', 'stoneDark');
    }
    chimney(a, 1.85, 0.35, 48);
    for (const [u, v] of [
      [2.55, 0.35],
      [3.65, 0.35],
      [2.55, 1.5],
      [3.65, 1.5],
      [2.55, 2.65],
      [3.65, 2.65],
    ] as const)
      tank(a, u, v, 0.95, 16);
    a.line(a.p(1.0, 1.6, 6), a.p(2.55, 1.95, 6), 'yellowDark');
    a.line(a.p(1.0, 1.7, 10), a.p(2.55, 3.1, 8), 'redDark');
    a.line(a.p(1.5, 0.9, 20), a.p(2.55, 0.8, 12), 'stoneDark');
    longShed(a, 0.3, 3.3, 1.9, 1.3, M.cream);
    return;
  }
  if (kind === 47) {
    // 석탄 화력: 냉각탑 2기 + 높은 굴뚝 + 발전동 + 석탄 더미
    coolingTower(a, 0.3, 0.3, 1.5, 44);
    coolingTower(a, 2.05, 0.3, 1.5, 40);
    office(a, 0.4, 2.2, 2.2, 1.3, 20, M.cream);
    chimney(a, 3.9, 1.0, 64);
    orePile(a, 2.9, 2.9, 1.6, 'stoneDark', 'ink');
    conveyor(a, 3.5, 3.4, 18, 2.6, 2.7, 16);
  }
}

/* ---------------- 군사 시설 (48~) ---------------- */

function militaryArt(a: PixelArt, kind: number, n: number): void {
  if (kind === 48) {
    // 병영: 막사 두 동, 연병장, 깃대, 감시탑, 담장
    a.slab(0.12, 0.12, n - 0.24, n - 0.24, 0, 'grassDark', 'shadow');
    a.slab(1.6, 1.7, 2.6, 2.0, 0, 'paving', 'pavingDark');
    for (let t = 1.75; t < 4.1; t += 0.45) a.line(a.p(t, 1.8), a.p(t, 3.6), 'pavingDark');
    longShed(a, 0.3, 0.3, 3.0, 0.9, M.teal);
    longShed(a, 0.3, 1.6, 1.0, 2.8, M.teal);
    office(a, 3.6, 0.35, 1.0, 0.9, 16, M.cream);
    // 깃대
    a.line(a.p(2.9, 2.7, 0), a.p(2.9, 2.7, 34), 'stoneDark');
    const flag = a.p(2.9, 2.7, 34);
    a.rect(flag[0] + 1, flag[1], 8, 5, 'red');
    a.rect(flag[0] + 1, flag[1] + 2, 8, 1, 'white');
    // 감시탑
    a.box(4.2, 4.2, 0.35, 0.35, 22, M.wood);
    a.box(4.12, 4.12, 0.5, 0.5, 4, M.roof, 22);
    // 담장
    for (const z of [3, 6]) {
      a.line(a.p(0.15, n - 0.15, z), a.p(n - 0.15, n - 0.15, z), 'stone');
      a.line(a.p(n - 0.15, 0.15, z), a.p(n - 0.15, n - 0.15, z), 'stone');
    }
    a.vehicle(2.0, 4.3, M.teal);
    a.vehicle(2.7, 4.3, M.teal);
    return;
  }
  if (kind === 50) {
    // 점령타워: 철골 탑 + 꼭대기 깃발, 발치에 천막과 모래주머니
    a.slab(0.1, 0.1, n - 0.2, n - 0.2, 0, 'soil', 'shadow');
    a.box(0.75, 0.75, 0.5, 0.5, 4, M.steel);
    for (const [u, v] of [
      [0.8, 0.8],
      [1.2, 0.8],
      [0.8, 1.2],
      [1.2, 1.2],
    ] as const)
      a.line(a.p(u, v, 4), a.p(1.0, 1.0, 46), 'stoneDark');
    a.line(a.p(0.82, 0.82, 18), a.p(1.18, 1.18, 30), 'stoneDark');
    a.line(a.p(1.18, 0.82, 18), a.p(0.82, 1.18, 30), 'stoneDark');
    a.box(0.88, 0.88, 0.24, 0.24, 4, M.roof, 46);
    const top = a.p(1.0, 1.0, 50);
    a.line(top, a.p(1.0, 1.0, 64), 'ink');
    const f = a.p(1.0, 1.0, 64);
    a.rect(f[0] + 1, f[1], 10, 6, 'red');
    a.rect(f[0] + 1, f[1] + 2, 10, 1, 'white');
    a.box(0.2, 1.35, 0.5, 0.4, 7, M.teal);
    for (const [u, v] of [
      [1.45, 0.25],
      [1.6, 0.5],
      [1.5, 1.55],
    ] as const)
      a.box(u, v, 0.22, 0.16, 3, M.yellow);
    return;
  }
  if (kind === 51) {
    // 군수 공장: 톱니 지붕 공장, 탄약 상자 더미, 굴뚝
    a.slab(0.1, 0.1, n - 0.2, n - 0.2, 0, 'paving', 'pavingDark');
    longShed(a, 0.25, 0.3, 2.0, 1.4, M.steel);
    for (let t = 0.35; t < 2.2; t += 0.4)
      a.line(a.p(t, 0.3, 16), a.p(t + 0.2, 0.3, 21), 'roofDark');
    chimney(a, 2.35, 0.4, 30);
    for (const [u, v] of [
      [0.4, 2.1],
      [0.8, 2.1],
      [1.2, 2.1],
      [0.6, 2.45],
      [1.0, 2.45],
    ] as const)
      a.box(u, v, 0.32, 0.26, 5, M.wood);
    a.vehicle(2.0, 2.4, M.teal);
    return;
  }
  if (kind === 52) {
    // 전차 공장: 큰 조립동 두 동, 시험 주행로, 줄지어 선 전차
    a.slab(0.1, 0.1, n - 0.2, n - 0.2, 0, 'paving', 'pavingDark');
    longShed(a, 0.3, 0.3, 2.6, 1.6, M.steel);
    longShed(a, 3.1, 0.3, 1.6, 1.6, M.teal);
    a.slab(0.4, 2.4, 4.2, 0.6, 0, 'soil', 'shadow');
    for (let u = 0.6; u < 4.4; u += 0.9) {
      a.box(u, 3.4, 0.55, 0.38, 5, M.teal);
      a.box(u + 0.15, 3.48, 0.25, 0.22, 3, M.teal, 5);
      a.line(a.p(u + 0.27, 3.59, 7), a.p(u + 0.27, 3.2, 7), 'ink');
    }
    office(a, 3.6, 3.8, 1.0, 0.8, 14, M.cream);
    return;
  }
  if (kind === 53) {
    // 레이더: 콘크리트 받침 위 회전 안테나, 작은 관제실
    a.slab(0.1, 0.1, n - 0.2, n - 0.2, 0, 'paving', 'pavingDark');
    a.box(0.7, 0.7, 0.6, 0.6, 10, M.cream);
    a.box(0.95, 0.95, 0.1, 0.1, 12, M.steel, 10);
    const c = a.p(1.0, 1.0, 26);
    a.rect(c[0] - 14, c[1] - 3, 28, 6, 'stone');
    a.rect(c[0] - 14, c[1] - 3, 28, 1, 'paper');
    a.rect(c[0] - 1, c[1] - 6, 2, 6, 'ink');
    a.box(1.35, 0.2, 0.45, 0.4, 8, M.teal);
    return;
  }
  if (kind === 54 || kind === 56) {
    // 군사 공항: 활주로, 격납고, 관제탑, 서 있는 비행기
    const big = kind === 56;
    a.slab(0.1, 0.1, n - 0.2, n - 0.2, 0, 'grassDark', 'shadow');
    a.slab(0.4, 4.6, n - 0.8, 1.1, 0, 'stoneDark', 'ink');
    for (let u = 0.8; u < n - 0.8; u += 0.7) a.line(a.p(u, 5.15), a.p(u + 0.35, 5.15), 'white');
    a.slab(0.6, 3.6, 3.5, 0.8, 0, 'paving', 'pavingDark');
    for (let i = 0; i < (big ? 3 : 2); i++) {
      const u = 0.5 + i * 1.9;
      a.box(u, 0.5, 1.6, 1.4, big ? 18 : 14, M.steel);
      a.slab(u + 0.05, 0.55, 1.5, 1.3, big ? 19 : 15, 'stone', 'stoneDark');
      a.rect(...a.p(u + 0.4, 1.9, 2), 18, 10, 'ink');
    }
    a.box(5.6, 2.2, 0.5, 0.5, 30, M.cream);
    a.box(5.5, 2.1, 0.7, 0.7, 6, M.glass, 30);
    for (const u of big ? [1.0, 2.4, 3.6] : [1.2, 2.8]) {
      const p0 = a.p(u, 3.95, 3);
      a.rect(p0[0] - 10, p0[1] - 1, 20, 3, big ? 'stoneDark' : 'stone');
      a.rect(p0[0] - 2, p0[1] - 6, 4, 12, big ? 'stoneDark' : 'stone');
    }
    return;
  }
  if (kind === 55) {
    // 해군 기지: 물가 부두, 정박한 군함, 창고·크레인
    a.slab(0.1, 0.1, n - 0.2, n - 0.2, 0, 'paving', 'pavingDark');
    a.slab(0.1, 4.4, n - 0.2, n - 4.5, 0, 'water', 'waterLight');
    a.slab(0.6, 3.6, 0.5, 2.8, 1, 'stone', 'stoneDark');
    a.slab(3.4, 3.6, 0.5, 2.8, 1, 'stone', 'stoneDark');
    for (const u of [1.4, 4.2]) {
      a.box(u, 4.7, 1.6, 0.6, 5, M.steel);
      a.box(u + 0.5, 4.8, 0.6, 0.4, 7, M.steel, 5);
      a.line(a.p(u + 0.8, 5.0, 12), a.p(u + 0.8, 5.0, 20), 'ink');
    }
    longShed(a, 0.4, 0.4, 2.6, 1.4, M.teal);
    office(a, 3.6, 0.5, 1.4, 1.0, 18, M.cream);
    crane(a, 2.9, 3.0);
    return;
  }
  if (kind === 57) {
    // 미사일 기지: 담장 안 원형 격납고(사일로) 넷, 발사대, 지휘소
    a.slab(0.1, 0.1, n - 0.2, n - 0.2, 0, 'grassDark', 'shadow');
    fence(a, n);
    for (const [u, v] of [
      [0.8, 0.8],
      [3.0, 0.8],
      [0.8, 3.0],
      [3.0, 3.0],
    ] as const) {
      a.slab(u, v, 1.2, 1.2, 0, 'stoneDark', 'ink');
      a.slab(u + 0.2, v + 0.2, 0.8, 0.8, 1, 'stone', 'ink');
      a.line(a.p(u + 0.2, v + 0.6, 1), a.p(u + 1.0, v + 0.6, 1), 'ink');
    }
    a.box(5.2, 1.0, 0.3, 0.3, 4, M.steel);
    a.box(5.28, 1.08, 0.14, 0.14, 34, M.cream, 4);
    a.box(5.28, 1.08, 0.14, 0.14, 5, M.red, 38);
    office(a, 4.8, 4.6, 1.4, 1.0, 10, M.steel);
    return;
  }
  if (kind === 58) {
    // 미사일 방어: 경사진 발사관 묶음 둘, 레이더 판
    a.slab(0.1, 0.1, n - 0.2, n - 0.2, 0, 'paving', 'pavingDark');
    for (const u of [0.25, 1.05]) {
      a.box(u, 0.9, 0.7, 0.5, 4, M.teal);
      for (let t = 0; t < 3; t++) a.box(u + 0.08 + t * 0.2, 0.95, 0.14, 0.38, 9, M.steel, 4 + t);
    }
    a.box(0.6, 0.15, 0.8, 0.12, 18, M.steel);
    a.slab(0.62, 0.16, 0.76, 0.1, 18, 'stone', 'stoneDark');
    return;
  }
  if (kind === 59) {
    // 정찰타워: 가는 나무 망루 + 꼭대기 망원경 지붕
    a.slab(0.15, 0.15, 0.7, 0.7, 0, 'soil', 'shadow');
    for (const [u, v] of [
      [0.3, 0.3],
      [0.7, 0.3],
      [0.3, 0.7],
      [0.7, 0.7],
    ] as const)
      a.line(a.p(u, v, 0), a.p(0.5, 0.5, 34), 'stoneDark');
    a.box(0.36, 0.36, 0.28, 0.28, 4, M.yellow, 34);
    const top = a.p(0.5, 0.5, 40);
    a.rect(top[0] - 1, top[1] - 6, 6, 2, 'ink');
    return;
  }
  if (kind === 60) {
    // 벌목장: 통나무 더미, 작업 창고, 남은 나무 몇 그루
    a.slab(0.1, 0.1, n - 0.2, n - 0.2, 0, 'soil', 'shadow');
    longShed(a, 0.3, 0.3, 1.3, 0.9, M.roof);
    for (let i = 0; i < 4; i++) a.box(0.4 + i * 0.12, 1.6, 0.9, 0.12, 2 + i * 0, M.yellow, i * 2);
    for (let i = 0; i < 3; i++) a.box(1.7, 1.5 + i * 0.12, 0.9, 0.12, 2, M.yellow, 6);
    a.tree(2.4, 0.5);
    a.tree(2.55, 1.0);
    a.tree(0.4, 2.5);
    return;
  }
  if (kind === 61) {
    // 탄약 공장: 둥근 지붕 저장고 둘 + 공장동, 굴뚝, 붉은 경고 띠
    a.slab(0.1, 0.1, n - 0.2, n - 0.2, 0, 'paving', 'pavingDark');
    longShed(a, 0.25, 0.25, 1.6, 1.1, M.steel);
    chimney(a, 2.2, 0.35, 28);
    for (const u of [0.3, 1.3]) {
      a.box(u, 1.65, 0.8, 0.8, 8, M.teal);
      const f = a.p(u + 0.4, 2.05, 8);
      a.rect(f[0] - 6, f[1] - 1, 12, 2, 'red');
    }
    return;
  }
  // 참호·벙커: 모래주머니 고리 + 낮은 콘크리트 벙커
  a.slab(0.08, 0.08, 0.84, 0.84, 0, 'soil', 'shadow');
  for (const [u, v] of [
    [0.12, 0.12],
    [0.42, 0.1],
    [0.7, 0.14],
    [0.1, 0.45],
    [0.12, 0.72],
    [0.72, 0.7],
  ] as const)
    a.box(u, v, 0.18, 0.14, 3, M.yellow);
  a.box(0.32, 0.32, 0.38, 0.36, 7, M.steel);
  const slit = a.p(0.51, 0.68, 4);
  a.rect(slit[0] - 4, slit[1] - 1, 8, 2, 'ink');
}

/** All civic facilities share the residential pixel grid and prop dimensions. */
export function facilityArt(kind: number): PixelArt {
  const n = FACILITY_SPAN[kind],
    a = new PixelArt(n * 64);
  a.ground(n, kind === 4 || kind === 5 || kind === 16 || (kind >= 27 && kind <= 32));
  if (kind >= 48) {
    militaryArt(a, kind, n);
    return a;
  }
  if (kind >= 36) {
    resourceArt(a, kind, n);
    return a;
  }
  if (kind >= 27) {
    foodArt(a, kind, n);
    return a;
  }
  if (kind === 26) {
    // One native 64px tile, 2:1 footprint. Low station hall with covered stairs.
    a.box(0.12, 0.12, 0.72, 0.55, 15, M.cream);
    a.box(0.16, 0.16, 0.64, 0.47, 3, M.roof, 15);
    for (let u = 0.22; u < 0.8; u += 0.12) a.line(a.p(u, 0.18, 18), a.p(u, 0.59, 18), 'roofDark');
    a.box(0.26, 0.23, 0.16, 0.12, 2, M.steel, 18);
    for (let z = 3; z < 15; z += 4) {
      a.line(a.p(0.13, 0.67, z), a.p(0.83, 0.67, z), 'stone');
      a.line(a.p(0.84, 0.13, z), a.p(0.84, 0.66, z), 'stoneDark');
    }
    a.windows(0.12, 0.12, 0.72, 0.55, 15);
    a.poly(
      [a.p(0.34, 0.68, 1), a.p(0.64, 0.68, 1), a.p(0.64, 0.68, 11), a.p(0.34, 0.68, 11)],
      'ink',
    );
    a.slab(0.26, 0.61, 0.46, 0.19, 12, 'tealDark');
    for (let i = 0; i < 3; i++)
      a.line(
        a.p(0.34, 0.72 + i * 0.06, 2 - i * 0.5),
        a.p(0.64, 0.72 + i * 0.06, 2 - i * 0.5),
        'stoneDark',
      );
    a.box(0.79, 0.8, 0.04, 0.04, 16, M.steel);
    const sign = a.p(0.81, 0.82, 17);
    a.rect(sign[0] - 4, sign[1] - 7, 9, 9, 'tealDark');
    // M wayfinding sign, hand-pixelled rather than a font glyph.
    a.line([sign[0] - 2, sign[1] - 1], [sign[0] - 2, sign[1] - 5], 'paper');
    a.line([sign[0] + 2, sign[1] - 1], [sign[0] + 2, sign[1] - 5], 'paper');
    a.dot(sign[0] - 1, sign[1] - 4, 'paper');
    a.dot(sign[0], sign[1] - 3, 'paper');
    a.dot(sign[0] + 1, sign[1] - 4, 'paper');
    a.box(0.1, 0.76, 0.16, 0.12, 3, M.brick);
    a.slab(0.1, 0.76, 0.16, 0.12, 4, 'leaf');
    a.box(0.88, 0.25, 0.04, 0.27, 3, M.wood);
    return a;
  }
  if (kind === 0 || kind === 1) {
    const color = kind === 0 ? M.red : M.blue;
    office(a, 0.2, 0.18, 1.35, 0.9, 18, color);
    if (kind === 0) {
      a.box(0.2, 0.18, 0.3, 0.3, 34, M.brick);
      for (let i = 0; i < 3; i++) {
        const x = 0.65 + i * 0.3;
        a.poly(
          [a.p(x, 1.09, 1), a.p(x + 0.23, 1.09, 1), a.p(x + 0.23, 1.09, 10), a.p(x, 1.09, 10)],
          'ink',
        );
        for (let z = 3; z < 10; z += 2) a.line(a.p(x, 1.1, z), a.p(x + 0.23, 1.1, z), 'stoneDark');
        a.vehicle(x, 1.35, M.red, true);
      }
      const p = a.p(1, 0.9, 20);
      a.rect(p[0] - 4, p[1] - 5, 8, 5, 'white');
      a.rect(p[0] - 1, p[1] - 5, 2, 5, 'red');
    } else {
      const [x, y] = a.p(1, 0.8, 21);
      a.poly(
        [
          [x - 5, y - 6],
          [x + 5, y - 6],
          [x + 4, y + 2],
          [x, y + 5],
          [x - 4, y + 2],
        ],
        'yellow',
        'ink',
      );
      a.rect(x - 1, y - 3, 3, 5, 'blue');
      a.vehicle(0.5, 1.4, M.blue, true);
      a.vehicle(1.05, 1.4, M.blue, true);
    }
    a.tree(0.2, 1.65);
    a.tree(1.7, 1.65);
  } else if (kind === 2) {
    office(a, 0.4, 0.25, 1.7, 1.35, 35, M.cream);
    office(a, 0.25, 1.15, 0.8, 1, 18, M.cream);
    office(a, 1.8, 0.45, 0.75, 1.65, 18, M.cream);
    a.cross(1.35, 1.05, 38);
    a.box(1.15, 1.6, 0.6, 0.5, 9, M.teal);
    a.vehicle(1.2, 2.25, M.cream, true);
    a.vehicle(1.8, 2.25, M.cream, true);
    a.line(a.p(1.2, 2.7), a.p(2.4, 2.7), 'red');
    a.tree(0.25, 2.6);
  } else if (kind === 3) {
    office(a, 0.2, 0.2, 2.4, 0.75, 25, M.brick);
    office(a, 0.2, 0.95, 0.7, 1.2, 17, M.brick);
    a.gable(0.18, 0.18, 2.44, 0.79, 25, M.roof);
    a.slab(1.1, 1.2, 1.45, 1.15, 0, 'yellow');
    a.line(a.p(1.8, 1.3), a.p(1.8, 2.2), 'white');
    const p = a.p(2.6, 0.5, 0);
    a.line(p, [p[0], p[1] - 25], 'paper');
    a.rect(p[0], p[1] - 25, 8, 4, 'red');
    treeRow(a, n);
  } else if (kind === 4 || kind === 5) {
    a.slab(0.12, n / 2 - 0.08, n - 0.24, 0.16, 0, 'paper');
    a.slab(n / 2 - 0.08, 0.12, 0.16, n - 0.24, 0, 'paper');
    if (n > 1) {
      basin(a, 0.72, 0.72, 0.55, 0.55);
      const p = a.p(1, 1, 7);
      a.rect(p[0] - 1, p[1] - 5, 2, 7, 'waterLight');
    }
    a.tree(0.25, 0.3);
    a.tree(n - 0.3, n - 0.28);
    if (n > 1) {
      a.tree(0.25, 1.5);
      a.tree(1.6, 0.4);
    }
    a.box(0.25, n - 0.45, 0.28, 0.12, 2, M.wood);
  } else if (kind === 6) {
    a.slab(0.3, 0.3, 2.2, 2.2, 1, 'red');
    a.slab(0.55, 0.5, 1.7, 1.85, 2, 'grassDark', 'white');
    a.line(a.p(0.55, 1.425, 3), a.p(2.25, 1.425, 3), 'white');
    a.slab(1, 0.5, 0.8, 0.32, 3, 'grassDark', 'white');
    a.slab(1, 2.03, 0.8, 0.32, 3, 'grassDark', 'white');
    for (const v of [0.48, 2.36]) {
      a.line(a.p(1, v, 1), a.p(1, v, 8), 'white');
      a.line(a.p(1, v, 8), a.p(1.8, v, 8), 'white');
      a.line(a.p(1.8, v, 8), a.p(1.8, v, 1), 'white');
    }
    for (let v = 0.4; v < 2.5; v += 0.4) a.box(0.15, v, 0.2, 0.28, 5, M.blue);
  } else if (kind >= 7 && kind <= 10) {
    office(a, 0.18, 0.18, n > 2 ? 0.8 : 0.65, 0.6, 13, M.teal);
    if (kind === 7) {
      a.box(1, 0.45, 0.55, 0.55, 20, M.blue);
      a.slab(1.04, 0.49, 0.47, 0.47, 21, 'glassLight');
      a.line(a.p(1.15, 1, 12), a.p(1.15, 1.7, 0), 'blueLight');
    } else if (kind === 10) {
      for (const u of [1.15, 2]) for (const v of [0.25, 1.2]) basin(a, u, v, 0.65, 0.7, true);
      a.line(a.p(0.6, 1), a.p(0.6, 2.65), 'tealLight');
    } else {
      basin(a, 0.95, 0.3, 0.65, 0.9, kind === 9);
      for (const u of [0.65, 1.05, 1.45]) {
        a.box(u, 1.3, 0.18, 0.38, 5, kind === 9 ? M.wood : M.blue);
        a.slab(u, 1.65, 0.18, 0.15, 1, kind === 9 ? 'soil' : 'water');
      }
    }
    a.tree(0.22, n - 0.3);
  } else if (kind === 11) {
    office(a, 0.22, 0.25, 0.6, 0.55, 10, M.cream);
    const base = a.p(1.1, 1.05),
      hub = a.p(1.1, 1.05, 53);
    a.rect(base[0] - 1, hub[1], 3, base[1] - hub[1], 'paper');
    for (const [dx, dy] of [
      [0, -20],
      [-17, 12],
      [17, 12],
    ]) {
      a.line(hub, [hub[0] + dx, hub[1] + dy], 'white');
      a.line([hub[0] + 1, hub[1]], [hub[0] + dx + 1, hub[1] + dy], 'paper');
    }
    a.rect(hub[0] - 2, hub[1] - 2, 5, 4, 'stoneDark');
  } else if (kind === 12 || kind === 14 || kind === 15) {
    office(
      a,
      0.25,
      0.25,
      n - 0.75,
      n - 0.9,
      kind === 15 ? 15 : 22,
      kind === 14 ? M.brick : M.steel,
    );
    chimney(a, n - 0.75, 0.38, kind === 15 ? 32 : 51);
    if (kind !== 15) chimney(a, n - 1.15, 0.38, 43);
    a.gable(0.23, 0.23, n - 0.71, n - 0.86, kind === 15 ? 15 : 22, M.roof);
    if (kind === 14)
      for (let x = 0.3; x < n - 0.5; x += 0.45) a.box(x, n - 0.55, 0.3, 0.3, 5, M.teal);
    else if (kind === 12)
      for (let x = 0.4; x < 2.2; x += 0.5) a.box(x, 2.25, 0.35, 0.35, 8, M.steel);
    else {
      a.tree(0.2, 1.6);
      a.tree(1.7, 1.6);
    }
  } else if (kind === 13) {
    for (let v = 0.2; v < n - 0.6; v += 0.62)
      for (let u = 0.2; u < n - 0.6; u += 0.8) solar(a, u, v);
    office(a, 0.3, 2.4, 0.65, 0.35, 7, M.cream);
  } else if (kind === 16) {
    a.slab(1.35, 0.15, 0.2, 2.55, 0, 'paper');
    for (let v = 0.35; v < 2.4; v += 0.5)
      for (const u of [0.4, 0.9, 1.9, 2.4]) {
        a.slab(u, v, 0.2, 0.28, 0, 'stone');
        a.box(u, v, 0.18, 0.05, 5, M.steel);
      }
    a.tree(0.2, 2.6);
    a.tree(2.7, 2.6);
  } else if (kind === 17) {
    const base = a.p(0.5, 0.5),
      top = a.p(0.5, 0.5, 35);
    a.line([base[0] - 8, base[1]], top, 'roof');
    a.line([base[0] + 8, base[1]], top, 'paper');
    for (let z = 8; z < 30; z += 7) {
      const w = 8 * (1 - z / 35);
      a.line([base[0] - w, base[1] - z], [base[0] + w, base[1] - z], 'paper');
    }
    a.rect(top[0] - 1, top[1] - 2, 3, 2, 'red');
    a.box(0.15, 0.65, 0.28, 0.2, 6, M.steel);
  } else if (kind === 20) {
    office(a, 0.35, 0.35, 2.1, 1.5, 20, M.steel);
    for (const u of [0.25, 2.4]) {
      a.box(u, 2.1, 0.3, 0.3, 24, M.steel);
      a.box(u - 0.04, 2.06, 0.38, 0.38, 5, M.blue, 24);
    }
    fence(a, n);
  } else if (kind === 18 || kind === 24 || kind === 25) {
    // More modules at larger airports; windows/aircraft retain their pixel size.
    office(a, 0.3, 0.3, n - 0.8, 0.9, 18, M.glass);
    a.box(0.4, 1.2, n - 1, 0.25, 7, M.steel);
    a.box(n - 0.9, 0.45, 0.3, 0.3, 43, M.steel);
    a.box(n - 1, 0.35, 0.5, 0.5, 7, M.glass, 43);
    for (let u = 0.55; u < n - 0.65; u += 0.8) {
      a.box(u, 1.45, 0.14, 0.65, 5, M.steel);
      a.line(a.p(u, 2.15), a.p(u, 2.65), 'yellow');
      const [x, y] = a.p(u, 2.4, 3);
      a.poly(
        [
          [x, y - 8],
          [x + 2, y - 2],
          [x + 11, y + 2],
          [x + 11, y + 4],
          [x + 2, y + 2],
          [x + 2, y + 8],
          [x + 5, y + 10],
          [x - 5, y + 10],
          [x - 2, y + 8],
          [x - 2, y + 2],
          [x - 11, y + 4],
          [x - 11, y + 2],
          [x - 2, y - 2],
        ],
        'white',
        'roofDark',
      );
    }
    if (n > 3) {
      for (let u = 0.4; u < n - 0.5; u += 0.5)
        for (let v = 3.2; v < n - 0.4; v += 0.55) {
          a.line(a.p(u, v), a.p(u + 0.35, v), 'white');
          a.vehicle(u, v + 0.1, M.blue);
        }
    }
  } else {
    // Ports have an unmistakable pier/crane silhouette. Basin is decorative art,
    // not extra navigable water; functional shoreline rules remain in simulation.
    a.slab(0.15, n * 0.58, n - 0.3, n * 0.38, 0, 'water', 'blueDark');
    const cargo = kind !== 19,
      passenger = kind !== 21;
    if (passenger) office(a, 0.25, 0.2, Math.min(n - 0.7, 2.2), 0.8, 20, M.cream);
    const start = passenger ? 1.2 : 0.25;
    if (cargo) {
      for (let v = start; v < n * 0.55; v += 0.45)
        for (let u = 0.25; u < n - 0.7; u += 0.7)
          a.box(u, v, 0.55, 0.28, 5, Math.round(u * 10 + v * 10) % 2 ? M.red : M.blue);
      for (let u = n > 3 ? 1 : 1.8; u < n - 0.3; u += 1.5) crane(a, u, n * 0.52);
    }
    for (let u = 0.45; u < n - 0.4; u += 1) {
      a.box(u, n * 0.58, 0.18, n * 0.3, 2, M.wood);
      const v = n * 0.77;
      a.box(u + 0.23, v, 0.35, 0.6, 3, passenger ? M.cream : M.red);
      a.box(u + 0.25, v + 0.17, 0.29, 0.22, 4, M.glass, 3);
      a.line(a.p(u + 0.28, v + 0.05, 4), a.p(u + 0.48, v + 0.05, 4), 'yellow');
    }
  }
  return a;
}
