import { MATERIAL as M, PixelArt, type Material, type PixelColor } from './pixelArt';

export interface BuildingCandidate {
  name: string;
  description: string;
  art: () => PixelArt;
}

function plot(a: PixelArt, path: PixelColor): void {
  a.slab(0.04, 0.04, 0.92, 0.92, 0, 'grass', 'grassDark');
  a.slab(0.42, 0.66, 0.17, 0.3, 1, path, 'pavingDark');
}

function detailedGable(
  a: PixelArt,
  u: number,
  v: number,
  w: number,
  d: number,
  h: number,
  material: Material,
): void {
  const rise = 6;
  a.gable(u, v, w, d, h, material);

  // Deep front eaves separate roof from facade even at 50% scale.
  a.line(a.p(u, v + d, h), a.p(u + w / 2, v + d, h + rise), material[2]);
  a.line(a.p(u + w / 2, v + d, h + rise), a.p(u + w, v + d, h), material[2]);
  a.line(a.p(u, v + d, h - 1), a.p(u + w, v + d, h - 1), 'ink');

  // Long tile courses create material texture without random single-pixel noise.
  for (const f of [0.18, 0.34]) {
    const z = h + rise * f * 2;
    a.line(a.p(u + w * f, v + 0.04, z), a.p(u + w * f, v + d - 0.02, z), material[1]);
    a.line(a.p(u + w * (1 - f), v + 0.04, z), a.p(u + w * (1 - f), v + d - 0.02, z), material[2]);
  }
  a.line(a.p(u + w / 2, v + 0.02, h + rise), a.p(u + w / 2, v + d, h + rise), material[0]);

  // Short, ordered pixel clusters keep the broad roof planes from reading as flat polygons.
  for (let row = 0; row < 3; row++) {
    const depth = v + 0.13 + row * 0.18;
    for (const f of [0.13, 0.31, 0.69, 0.87]) {
      const z = h + rise * (1 - Math.abs(f * 2 - 1)),
        [x, y] = a.p(u + w * f, depth, z);
      a.rect(x - 1, y, 3, 1, row % 2 ? material[0] : material[1]);
      if (f > 0.5) a.dot(x + 1, y + 1, material[2]);
    }
  }
}

function frontWindow(
  a: PixelArt,
  u: number,
  v: number,
  z: number,
  trim: PixelColor,
  lit = false,
): void {
  const [x, y] = a.p(u, v, z);
  a.rect(x - 3, y - 5, 7, 6, 'ink');
  a.rect(x - 2, y - 4, 5, 4, trim);
  a.rect(x, y - 4, 1, 4, 'paper');
  a.rect(x - 2, y - 2, 5, 1, 'paper');
  a.dot(x - 1, y - 3, lit ? 'yellowLight' : 'glassLight');
}

function sideWindow(a: PixelArt, u: number, v: number, z: number): void {
  const [x, y] = a.p(u, v, z);
  a.rect(x - 2, y - 5, 6, 6, 'ink');
  a.rect(x - 1, y - 4, 4, 4, 'glass');
  a.line([x + 1, y - 4], [x + 1, y - 1], 'paper');
  a.dot(x, y - 3, 'glassLight');
}

function frontFence(a: PixelArt, color: PixelColor = 'wood'): void {
  for (const [from, to] of [
    [0.07, 0.36],
    [0.66, 0.93],
  ] as const) {
    a.line(a.p(from, 0.92, 2), a.p(to, 0.92, 2), color);
    a.line(a.p(from, 0.92, 4), a.p(to, 0.92, 4), color);
    for (let u = from; u <= to + 0.01; u += 0.095) {
      a.line(a.p(u, 0.92, 0), a.p(u, 0.92, 5), 'woodLight');
      a.dot(...a.p(u, 0.92, 5), 'paper');
    }
  }
}

function flowers(a: PixelArt, u: number, v: number): void {
  for (const [du, dv, color] of [
    [0, 0, 'redLight'],
    [0.08, 0.02, 'yellowLight'],
    [0.15, -0.01, 'white'],
  ] as const) {
    const [x, y] = a.p(u + du, v + dv, 2);
    a.dot(x, y, color);
    a.dot(x, y + 1, 'leafDark');
  }
}

function redGardenHouse(): PixelArt {
  const a = new PixelArt(64);
  plot(a, 'soil');
  a.slab(0.38, 0.69, 0.26, 0.26, 1, 'soil', 'pavingDark');
  a.hedge(0.08, 0.1, 0.38);

  a.box(0.15, 0.13, 0.68, 0.56, 16, M.plaster);
  a.line(a.p(0.15, 0.69, 3), a.p(0.83, 0.69, 3), 'plasterDark');
  a.box(0.22, 0.23, 0.09, 0.1, 7, M.brick, 16);
  detailedGable(a, 0.12, 0.1, 0.74, 0.62, 16, M.terracotta);

  frontWindow(a, 0.3, 0.69, 9, 'blue', true);
  sideWindow(a, 0.83, 0.31, 9);
  a.door(0.56, 0.69);
  a.slab(0.46, 0.69, 0.2, 0.12, 7, 'terracottaDark', 'ink');
  a.line(a.p(0.47, 0.81, 1), a.p(0.47, 0.81, 7), 'wood');
  a.line(a.p(0.64, 0.81, 1), a.p(0.64, 0.81, 7), 'wood');

  a.tree(0.14, 0.72);
  flowers(a, 0.7, 0.76);
  frontFence(a);
  return a;
}

function blueSlateHouse(): PixelArt {
  const a = new PixelArt(64);
  plot(a, 'paving');
  a.hedge(0.08, 0.11, 0.52);
  a.hedge(0.82, 0.2, 0.13);

  a.box(0.14, 0.14, 0.7, 0.55, 15, M.plaster);
  a.line(a.p(0.14, 0.69, 3), a.p(0.84, 0.69, 3), 'slateDark');
  a.box(0.7, 0.22, 0.08, 0.1, 6, M.brick, 15);
  detailedGable(a, 0.11, 0.11, 0.76, 0.61, 15, M.slate);

  // Framed roof window gives this variant a distinct upper silhouette.
  const dormer = a.p(0.47, 0.63, 18);
  a.rect(dormer[0] - 4, dormer[1] - 5, 9, 6, 'slateDark');
  a.rect(dormer[0] - 2, dormer[1] - 4, 5, 4, 'glassLight');
  a.line([dormer[0], dormer[1] - 4], [dormer[0], dormer[1] - 1], 'paper');

  frontWindow(a, 0.3, 0.69, 8, 'glassLight');
  sideWindow(a, 0.84, 0.3, 8);
  a.door(0.58, 0.69);
  a.slab(0.49, 0.69, 0.18, 0.13, 7, 'slate', 'ink');
  a.line(a.p(0.5, 0.81, 1), a.p(0.5, 0.81, 7), 'slateDark');
  a.line(a.p(0.65, 0.81, 1), a.p(0.65, 0.81, 7), 'slateDark');

  a.tree(0.13, 0.76);
  flowers(a, 0.69, 0.78);
  frontFence(a, 'slateDark');
  return a;
}

function brickTownHouse(): PixelArt {
  const a = new PixelArt(64);
  a.slab(0.04, 0.04, 0.92, 0.92, 0, 'paving', 'pavingDark');
  a.slab(0.41, 0.68, 0.18, 0.28, 1, 'soil', 'pavingDark');
  a.slab(0.08, 0.1, 0.35, 0.14, 1, 'grassDark', 'ink');

  a.box(0.13, 0.12, 0.73, 0.6, 20, M.brick);
  for (const z of [4, 11, 18])
    a.line(a.p(0.13, 0.72, z), a.p(0.86, 0.72, z), z === 18 ? 'brickDark' : 'brickLight');
  a.box(0.71, 0.19, 0.09, 0.1, 7, M.brick, 20);
  detailedGable(a, 0.1, 0.09, 0.79, 0.66, 20, M.slate);

  frontWindow(a, 0.29, 0.72, 8, 'glassLight');
  frontWindow(a, 0.29, 0.72, 16, 'blue', true);
  sideWindow(a, 0.86, 0.3, 9);
  sideWindow(a, 0.86, 0.3, 17);
  a.door(0.59, 0.72);
  a.slab(0.51, 0.72, 0.17, 0.11, 7, 'slateDark', 'ink');

  // Narrow urban forecourt: low wall, bins and a small flower strip.
  a.box(0.08, 0.82, 0.3, 0.07, 3, M.brick);
  a.box(0.7, 0.8, 0.1, 0.1, 4, M.teal);
  a.box(0.81, 0.75, 0.09, 0.1, 4, M.blue);
  flowers(a, 0.13, 0.74);
  return a;
}

export const BUILDING_CANDIDATES: readonly BuildingCandidate[] = [
  {
    name: '규격 후보 A · 붉은 기와 정원주택',
    description: '기와선·처마 그림자·굴뚝·흙길·울타리·나무·화단',
    art: redGardenHouse,
  },
  {
    name: '규격 후보 B · 푸른 슬레이트 주택',
    description: '슬레이트 이음선·지붕창·현관 캐노피·포장길·생울타리',
    art: blueSlateHouse,
  },
  {
    name: '규격 후보 C · 벽돌 도시주택',
    description: '2층 창 배열·벽돌 띠·진한 처마·담장·수거함·좁은 앞마당',
    art: brickTownHouse,
  },
];
