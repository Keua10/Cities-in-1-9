import { MATERIAL as M, PixelArt, type Material } from './pixelArt';

export const BUILDING_ART_VARIANTS = 4;
/** Architectural names describe appearance; they do not invent new economic subtypes. */
export const BUILDING_NAMES: readonly (readonly (readonly string[])[])[] = [
  [
    ['기와 단독주택', '슬레이트 주택', '텃밭 단독주택', '붉은 벽돌 타운하우스'],
    ['발코니 연립주택', '중정 공동주택', '놀이터 벽돌 아파트', '중정 연립주택'],
    ['정원 저택', '테라스 공동주택', '대단지 중정 아파트', '옥상정원 공동주택'],
  ],
  [
    ['차양 상점', '모퉁이 상점', '편의점', '노천 식당'],
    ['거리 상가', '유리 업무동', '동네 슈퍼마켓', '복합 업무상가'],
    ['아트리움 상가', '유리 업무 타워', '아트리움 백화점', '호텔 업무 타워'],
  ],
  [
    ['벽돌 작업장', '박공지붕 작업장', '자동차 정비소', '톱니지붕 작업장'],
    ['톱니지붕 공장', '저장탱크 공장', '물류 창고', '식품 가공 공장'],
    ['대형 생산동', '저장탱크 산업단지', '광역 물류센터', '정밀 전자 공업단지'],
  ],
];

function rooftop(a: PixelArt, u: number, v: number, w: number, d: number, z: number): void {
  a.slab(u + 0.06, v + 0.06, w - 0.12, d - 0.12, z + 1, 'roof');
  // Fixed-size roof seams, skylights and plant rooms add detail without texture noise.
  for (let t = 0.5; t < d - 0.1; t += 0.5)
    a.line(a.p(u + 0.08, v + t, z + 1), a.p(u + w - 0.08, v + t, z + 1), 'roofDark');
  if (w > 1.2 && d > 0.8) {
    a.box(u + w - 0.65, v + 0.16, 0.4, 0.28, 3, M.glass, z + 1);
    a.line(a.p(u + w - 0.45, v + 0.16, z + 4), a.p(u + w - 0.45, v + 0.44, z + 4), 'paper');
    a.box(u + 0.16, v + d - 0.4, 0.25, 0.2, 3, M.steel, z + 1);
  }
  if (w > 0.55 && d > 0.55) {
    a.box(u + 0.12, v + 0.12, 0.22, 0.18, 3, M.steel, z + 1);
    const p = a.p(u + 0.2, v + 0.2, z + 5);
    a.rect(p[0] - 2, p[1] - 1, 4, 2, 'roofDark');
  }
}

function block(
  a: PixelArt,
  u: number,
  v: number,
  w: number,
  d: number,
  h: number,
  m: Material,
  roof = true,
): void {
  a.box(u, v, w, d, h, m);
  a.windows(u, v, w, d, h);
  if (roof) rooftop(a, u, v, w, d, h);
  a.door(u + w * 0.55, v + d);
}

function balconies(a: PixelArt, u: number, v: number, w: number, h: number): void {
  for (let z = 8; z < h; z += 8) {
    a.box(u + 0.06, v, w - 0.12, 0.12, 2, M.steel, z);
    for (let x = 0.12; x < w - 0.05; x += 0.25) {
      const p = a.p(u + x, v + 0.12, z + 2);
      a.rect(p[0], p[1] - 1, 2, 2, 'leaf');
    }
  }
}

function awning(a: PixelArt, u: number, v: number, w: number, z: number, m: Material): void {
  a.box(u, v, w, 0.2, 2, m, z);
  for (let x = 0.05; x < w - 0.08; x += 0.18) a.slab(u + x, v, 0.07, 0.2, z + 2, 'white');
}

function shopfront(a: PixelArt, u: number, v: number, w: number, m: Material): void {
  for (let x = 0.08; x < w - 0.15; x += 0.3) {
    a.poly(
      [a.p(u + x, v, 2), a.p(u + x + 0.2, v, 2), a.p(u + x + 0.2, v, 7), a.p(u + x, v, 7)],
      'glassLight',
      'ink',
    );
  }
  awning(a, u, v, w, 8, m);
}

function tank(a: PixelArt, u: number, v: number, z = 12): void {
  a.box(u, v, 0.32, 0.32, z, M.steel);
  a.slab(u + 0.05, v + 0.05, 0.22, 0.22, z + 1, 'white', 'stoneDark');
  a.line(a.p(u + 0.26, v + 0.32, 2), a.p(u + 0.26, v + 0.32, z), 'roofDark');
}

/** Every recipe is built at its actual 64/128/192px cell size. */
export function buildingArt(level: number, zone: number, variant: number): PixelArt {
  const a = new PixelArt(level * 64),
    n = level;
  a.ground(n, zone === 0);
  const m = variant % 2 ? M.cream : M.brick;
  if (zone === 0) {
    if (level === 1) {
      const w = variant === 2 ? 0.68 : 0.56,
        d = variant === 3 ? 0.46 : 0.58;
      const h = variant === 2 ? 17 : 10;
      block(a, 0.16, 0.14, w, d, h, m, false);
      a.gable(0.14, 0.12, w + 0.04, d + 0.04, h, variant === 1 ? M.roof : M.red);
      if (variant !== 2) a.box(0.23, 0.23, 0.1, 0.1, 7, M.brick, h);
    } else if (variant === 0) {
      const h = level === 2 ? 25 : 30;
      block(a, 0.23, 0.2, n - 0.62, n - 0.8, h, m, level === 2);
      if (level === 3) a.gable(0.2, 0.17, n - 0.56, n - 0.74, h, M.roof);
      balconies(a, 0.23, n - 0.6, n - 0.62, h);
    } else if (variant === 1) {
      block(a, 0.2, 0.2, n - 0.5, 0.62, 32 + (n - 2) * 8, M.cream);
      block(a, 0.2, 0.82, 0.6, n - 1.1, 24, M.brick);
      if (n === 3) {
        block(a, 1.9, 0.85, 0.7, 1.3, 24, M.cream);
        balconies(a, 1.9, 2.15, 0.7, 24);
      }
      a.tree(n / 2, n - 0.55);
    } else if (variant === 2) {
      for (let v = 0.2; v < n - 0.5; v += 0.65) {
        block(a, 0.25, v, n - 0.75, 0.55, 18 + Math.round((n - v) * 4), M.cream, false);
        a.gable(0.23, v - 0.02, n - 0.71, 0.59, 18 + Math.round((n - v) * 4), M.roof);
      }
    } else {
      block(a, 0.25, 0.2, n - 0.75, n - 0.65, n === 2 ? 34 : 46, M.cream);
      balconies(a, 0.25, n - 0.45, n - 0.75, n === 2 ? 34 : 46);
      a.box(0.45, 0.35, n - 1.15, 0.5, 8, M.brick, n === 2 ? 34 : 46);
    }
    a.hedge(0.15, n - 0.35, Math.max(0.25, n * 0.32));
    a.tree(n - 0.27, n - 0.35);
    if (n > 1) a.tree(0.22, n - 0.4);
  } else if (zone === 1) {
    const heights =
      level === 1 ? [11, 18, 12, 10] : level === 2 ? [26, 34, 18, 30] : [35, 62, 30, 38];
    const h = heights[variant],
      w = n - 0.5,
      d = n - 0.72;
    if (variant === 1) {
      block(a, 0.2, 0.18, w, Math.max(0.45, d), h, M.glass);
      for (let z = 8; z < h; z += 8)
        a.line(
          a.p(0.2, 0.18 + Math.max(0.45, d), z),
          a.p(0.2 + w, 0.18 + Math.max(0.45, d), z),
          'paper',
        );
    } else if (variant === 2 && n > 1) {
      block(a, 0.2, 0.2, n - 0.5, 0.65, h, M.cream);
      block(a, 0.2, 0.85, 0.65, n - 1.25, 18, M.brick);
      shopfront(a, 0.2, n - 0.4, 0.65, M.red);
      a.slab(1, 1, n - 1.35, n - 1.45, 0, 'paper');
      a.tree(n - 0.45, n - 0.55);
    } else {
      block(a, 0.2, 0.15, w, Math.max(0.45, d), h, variant === 3 ? M.brick : M.cream);
      if (n > 1 && variant === 0) {
        a.box(0.35, 0.3, w - 0.3, 0.4, 5, M.glass, h);
        for (let x = 0.4; x < n - 0.4; x += 0.25)
          a.line(a.p(x, 0.3, h + 5), a.p(x, 0.7, h + 5), 'paper');
      }
    }
    shopfront(a, 0.2, 0.15 + Math.max(0.45, d), w, variant % 2 ? M.teal : M.red);
    const sign = a.p(0.28, 0.15 + Math.max(0.45, d), Math.min(h - 1, 15));
    a.rect(sign[0], sign[1] - 3, 7, 3, variant % 2 ? 'yellow' : 'blue');
    if (n > 1) {
      a.tree(0.18, n - 0.27);
      a.vehicle(n - 0.7, n - 0.32, M.blue);
    }
  } else {
    const u = 0.14,
      v = 0.13,
      w = n - 0.55,
      d = Math.max(0.45, n - 0.65),
      h = level === 1 ? 10 : 17;
    if (variant === 1 && n > 1) {
      block(a, 0.2, 0.2, n - 1.1, n - 0.7, h, M.brick, false);
      tank(a, n - 0.7, 0.25, 20);
      tank(a, n - 0.7, 0.8, 16);
    } else if (variant === 3 && n > 1) {
      block(a, 0.2, 0.15, n - 0.55, 0.65, h + 9, M.steel);
      block(a, 0.2, 0.8, 0.75, n - 1.1, h, M.brick);
      a.gable(0.18, 0.78, 0.79, n - 1.06, h, M.roof);
    } else {
      a.box(u, v, Math.max(0.4, w), d, h, variant === 2 ? M.steel : M.brick);
      if ((variant === 0 && n > 1) || variant === 3) {
        const bays = n === 1 ? 2 : n + 1,
          step = d / bays;
        for (let i = 0; i < bays; i++) a.gable(u, v + i * step, Math.max(0.4, w), step, h, M.roof);
      } else if (variant === 0 && n === 1) rooftop(a, u, v, Math.max(0.4, w), d, h);
      else a.gable(u, v, Math.max(0.4, w), d, h, M.roof);
    }
    // Large roller doors and loading apron distinguish industry from storefronts.
    for (let x = 0.24; x < n - 0.5; x += 0.48) {
      const y = v + d;
      a.poly(
        [a.p(x, y, 1), a.p(x + 0.3, y, 1), a.p(x + 0.3, y, 9), a.p(x, y, 9)],
        'roofDark',
        'ink',
      );
      for (let z = 2; z < 9; z += 2) a.line(a.p(x, y, z), a.p(x + 0.3, y, z), 'stoneDark');
      a.line(a.p(x, y + 0.08), a.p(x + 0.3, y + 0.08), 'yellow');
    }
    if (n > 1) {
      a.box(n - 0.5, n - 0.9, 0.12, 0.12, 28, M.brick);
      a.box(0.25, n - 0.45, 0.28, 0.23, 4, M.wood);
      a.vehicle(n - 0.85, n - 0.32, M.yellow);
    } else a.box(n - 0.27, 0.22, 0.08, 0.08, 19, M.brick);
  }
  return a;
}
