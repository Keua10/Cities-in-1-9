import { FACILITY_SPAN } from '../sim/config/facilities';
import { MATERIAL as M, PixelArt, type Material } from './pixelArt';

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

/** All 26 civic facilities share the residential pixel grid and prop dimensions. */
export function facilityArt(kind: number): PixelArt {
  const n = FACILITY_SPAN[kind],
    a = new PixelArt(n * 64);
  a.ground(n, kind === 4 || kind === 5 || kind === 16);
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
