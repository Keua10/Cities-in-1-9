/** Shared native-resolution pixel art. One art pixel is one world pixel at zoom 1.
 * No Canvas paths, antialiasing, per-tier scaling or random render-time values.
 */
export const PIXEL_PALETTE = {
  ink: '#293c43',
  shadow: '#44565a',
  white: '#f0ead5',
  paper: '#d7d7c4',
  stone: '#b6bbac',
  stoneDark: '#83938a',
  paving: '#b6ada0',
  pavingDark: '#817f75',
  grass: '#7c9d5b',
  grassLight: '#99b96c',
  grassDark: '#567a48',
  leaf: '#497447',
  leafLight: '#7d9a49',
  leafDark: '#315744',
  wood: '#9a704d',
  woodLight: '#c09761',
  brick: '#b36b50',
  brickLight: '#d18a66',
  brickDark: '#885342',
  roof: '#607783',
  roofLight: '#82939a',
  roofDark: '#455962',
  red: '#c55345',
  redLight: '#e48261',
  redDark: '#903f3c',
  blue: '#4681a4',
  blueLight: '#79aabb',
  blueDark: '#345d78',
  glass: '#639cad',
  glassLight: '#abd0ce',
  glassDark: '#3f6578',
  yellow: '#dbad50',
  yellowLight: '#f1d185',
  yellowDark: '#a57d3e',
  teal: '#428e82',
  tealLight: '#73b5a0',
  tealDark: '#326960',
  water: '#48859c',
  waterLight: '#7eafba',
  soil: '#87735a',
} as const;

export type PixelColor = keyof typeof PIXEL_PALETTE;
export type Point = readonly [number, number];
export type Material = readonly [PixelColor, PixelColor, PixelColor];
export const MATERIAL = {
  cream: ['white', 'paper', 'stone'],
  brick: ['brickLight', 'brick', 'brickDark'],
  roof: ['roofLight', 'roof', 'roofDark'],
  glass: ['glassLight', 'glass', 'glassDark'],
  red: ['redLight', 'red', 'redDark'],
  blue: ['blueLight', 'blue', 'blueDark'],
  teal: ['tealLight', 'teal', 'tealDark'],
  steel: ['paper', 'stone', 'stoneDark'],
  wood: ['woodLight', 'wood', 'soil'],
  yellow: ['yellowLight', 'yellow', 'yellowDark'],
} as const satisfies Record<string, Material>;

const rgba = Object.fromEntries(
  Object.entries(PIXEL_PALETTE).map(([k, v]) => [
    k,
    [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16), 255],
  ]),
) as Record<PixelColor, number[]>;

export class PixelArt {
  readonly data: Uint8ClampedArray;
  clippedPixels = 0;
  constructor(readonly size: number) {
    this.data = new Uint8ClampedArray(size * size * 4);
  }
  dot(x: number, y: number, color: PixelColor): void {
    x = Math.round(x);
    y = Math.round(y);
    // A one-pixel transparent gutter prevents adjacent atlas cells bleeding.
    if (x < 1 || y < 1 || x >= this.size - 1 || y >= this.size - 1) {
      this.clippedPixels++;
      return;
    }
    this.data.set(rgba[color], (y * this.size + x) * 4);
  }
  rect(x: number, y: number, w: number, h: number, c: PixelColor): void {
    for (let yy = Math.round(y); yy < Math.round(y + h); yy++)
      for (let xx = Math.round(x); xx < Math.round(x + w); xx++) this.dot(xx, yy, c);
  }
  line(a: Point, b: Point, c: PixelColor): void {
    let x = Math.round(a[0]),
      y = Math.round(a[1]);
    const x1 = Math.round(b[0]),
      y1 = Math.round(b[1]);
    const dx = Math.abs(x1 - x),
      dy = -Math.abs(y1 - y),
      sx = x < x1 ? 1 : -1,
      sy = y < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.dot(x, y, c);
      if (x === x1 && y === y1) break;
      const e = err * 2;
      if (e >= dy) {
        err += dy;
        x += sx;
      }
      if (e <= dx) {
        err += dx;
        y += sy;
      }
    }
  }
  poly(points: readonly Point[], color: PixelColor, edge?: PixelColor): void {
    const min = Math.floor(Math.min(...points.map((p) => p[1]))),
      max = Math.ceil(Math.max(...points.map((p) => p[1])));
    for (let y = min; y <= max; y++) {
      const xs: number[] = [];
      for (let i = 0; i < points.length; i++) {
        const a = points[i],
          b = points[(i + 1) % points.length];
        if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y))
          xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2)
        for (let x = Math.ceil(xs[i]); x <= Math.floor(xs[i + 1]); x++) this.dot(x, y, color);
    }
    if (edge) points.forEach((p, i) => this.line(p, points[(i + 1) % points.length], edge));
  }
  /** Ground origin is the back corner; 1 tile always projects to 32x16 per axis. */
  p(u: number, v: number, z = 0): Point {
    return [this.size / 2 + (u - v) * 32, this.size / 2 + (u + v) * 16 - z - 2];
  }
  slab(
    u: number,
    v: number,
    w: number,
    d: number,
    z: number,
    c: PixelColor,
    edge?: PixelColor,
  ): void {
    this.poly(
      [this.p(u, v, z), this.p(u + w, v, z), this.p(u + w, v + d, z), this.p(u, v + d, z)],
      c,
      edge,
    );
  }
  box(u: number, v: number, w: number, d: number, h: number, m: Material, z = 0): void {
    this.poly(
      [
        this.p(u, v + d, z),
        this.p(u + w, v + d, z),
        this.p(u + w, v + d, z + h),
        this.p(u, v + d, z + h),
      ],
      m[1],
      'ink',
    );
    this.poly(
      [
        this.p(u + w, v, z),
        this.p(u + w, v + d, z),
        this.p(u + w, v + d, z + h),
        this.p(u + w, v, z + h),
      ],
      m[2],
      'ink',
    );
    this.slab(u, v, w, d, z + h, m[0], 'ink');
    this.line(this.p(u, v + d, z + h), this.p(u + w, v + d, z + h), 'paper');
    if (h >= 15) {
      this.line(this.p(u, v + d, z + 2), this.p(u + w, v + d, z + 2), m[2]);
      this.line(this.p(u + w, v, z + 2), this.p(u + w, v + d, z + 2), 'shadow');
    }
  }
  windows(u: number, v: number, w: number, d: number, h: number, lit = false): void {
    // Every tier uses the same 8px floor pitch and 3px window height.
    for (let z = 4; z < h - 2; z += 8) {
      for (let x = 0.125; x < w - 0.08; x += 0.25) {
        const [px, py] = this.p(u + x, v + d, z);
        this.rect(px, py - 3, 3, 4, 'ink');
        this.rect(px, py - 3, 2, 2, lit ? 'yellowLight' : 'glassLight');
      }
      for (let y = 0.125; y < d - 0.08; y += 0.25) {
        const [px, py] = this.p(u + w, v + y, z);
        this.rect(px - 2, py - 3, 3, 4, 'ink');
        this.rect(px - 1, py - 3, 2, 2, 'glass');
      }
    }
  }
  gable(u: number, v: number, w: number, d: number, h: number, c: Material = MATERIAL.red): void {
    const rise = 6;
    this.poly(
      [
        this.p(u, v, h),
        this.p(u + w / 2, v, h + rise),
        this.p(u + w / 2, v + d, h + rise),
        this.p(u, v + d, h),
      ],
      c[0],
      'ink',
    );
    this.poly(
      [
        this.p(u + w / 2, v, h + rise),
        this.p(u + w, v, h),
        this.p(u + w, v + d, h),
        this.p(u + w / 2, v + d, h + rise),
      ],
      c[2],
      'ink',
    );
    this.poly(
      [this.p(u, v + d, h), this.p(u + w, v + d, h), this.p(u + w / 2, v + d, h + rise)],
      c[1],
      'ink',
    );
    for (let t = 0.125; t < d; t += 0.125)
      this.line(this.p(u, v + t, h), this.p(u + w / 2, v + t, h + rise), c[1]);
    this.line(this.p(u + w / 2, v, h + rise), this.p(u + w / 2, v + d, h + rise), 'paper');
  }
  tree(u: number, v: number): void {
    const [x, y] = this.p(u, v);
    this.rect(x - 1, y - 7, 2, 7, 'wood');
    this.poly(
      [
        [x - 2, y - 17],
        [x + 2, y - 17],
        [x + 4, y - 14],
        [x + 5, y - 10],
        [x + 3, y - 7],
        [x - 3, y - 7],
        [x - 5, y - 10],
        [x - 4, y - 14],
      ],
      'leafDark',
    );
    this.poly(
      [
        [x - 2, y - 16],
        [x + 1, y - 16],
        [x + 3, y - 13],
        [x + 3, y - 10],
        [x, y - 8],
        [x - 4, y - 10],
        [x - 4, y - 13],
      ],
      'leaf',
    );
    this.rect(x - 2, y - 15, 3, 3, 'leafLight');
    this.rect(x - 3, y - 11, 2, 2, 'leafLight');
    this.dot(x + 2, y - 10, 'grassLight');
  }
  hedge(u: number, v: number, length: number): void {
    this.box(u, v, length, 0.09, 3, ['grassLight', 'grassDark', 'leafDark']);
  }
  door(u: number, v: number): void {
    const [x, y] = this.p(u, v);
    this.rect(x - 2, y - 6, 5, 7, 'ink');
    this.rect(x - 1, y - 5, 3, 5, 'wood');
    this.dot(x + 1, y - 2, 'yellowLight');
  }
  cross(u: number, v: number, z: number, color: PixelColor = 'red'): void {
    const [x, y] = this.p(u, v, z);
    this.rect(x - 6, y - 6, 13, 13, 'white');
    this.rect(x - 2, y - 5, 5, 11, color);
    this.rect(x - 5, y - 2, 11, 5, color);
  }
  vehicle(u: number, v: number, m: Material, emergency = false): void {
    this.box(u, v, 0.35, 0.17, 3, m);
    this.box(u + 0.1, v, 0.15, 0.17, 2, MATERIAL.glass, 3);
    const [x, y] = this.p(u + 0.08, v + 0.17);
    this.rect(x - 1, y - 1, 2, 2, 'ink');
    this.rect(x + 6, y + 2, 2, 2, 'ink');
    if (emergency) {
      const p = this.p(u + 0.18, v + 0.08, 6);
      this.rect(p[0], p[1], 2, 1, 'red');
      this.rect(p[0] + 2, p[1], 2, 1, 'blueLight');
    }
  }
  ground(span: number, lawn: boolean): void {
    this.slab(0.04, 0.04, span - 0.08, span - 0.08, 0, lawn ? 'grass' : 'paving', 'pavingDark');
    this.slab(0.09, span - 0.25, span - 0.18, 0.16, 0, 'paper');
    this.slab(span - 0.25, 0.09, 0.16, span - 0.18, 0, 'stone');
    if (!lawn)
      for (let u = 0.5; u < span; u += 0.5)
        this.line(this.p(u, 0.1), this.p(u, span - 0.1), 'stone');
  }
  paint(ctx: CanvasRenderingContext2D, x = 0, y = 0): void {
    const pixels = ctx.createImageData(this.size, this.size);
    pixels.data.set(this.data);
    ctx.putImageData(pixels, x, y);
  }
}
