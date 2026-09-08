import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// ImageGen 원본의 가짜 체크 배경을 외부 flood fill로만 제거한다.
// 건물 안쪽의 흰 벽/회색 지붕/창문은 보존한다. 원본은 tools/art 에 함께 보관.
const source = await loadImage(
  readFileSync(new URL('./art/facilities-source.png', import.meta.url)),
);
const input = createCanvas(source.width, source.height),
  ctx = input.getContext('2d');
ctx.drawImage(source, 0, 0);
const pixels = ctx.getImageData(0, 0, input.width, input.height);
const { data } = pixels,
  w = input.width,
  h = input.height,
  n = w * h;
const outside = new Uint8Array(n),
  queue = new Int32Array(n);
let head = 0,
  tail = 0;
const background = (i) => {
  const r = data[i * 4],
    g = data[i * 4 + 1],
    b = data[i * 4 + 2];
  return Math.min(r, g, b) >= 222 && Math.max(r, g, b) - Math.min(r, g, b) <= 18;
};
const visit = (i) => {
  if (i < 0 || i >= n || outside[i] || !background(i)) return;
  outside[i] = 1;
  queue[tail++] = i;
};
for (let x = 0; x < w; x++) {
  visit(x);
  visit((h - 1) * w + x);
}
for (let y = 0; y < h; y++) {
  visit(y * w);
  visit(y * w + w - 1);
}
while (head < tail) {
  const i = queue[head++],
    x = i % w;
  if (x) visit(i - 1);
  if (x < w - 1) visit(i + 1);
  visit(i - w);
  visit(i + w);
}
// 체육시설 왼쪽 펜스로 닫힌 배경 구멍. 이 영역 안의 체크색만 추가로 제거한다.
for (let y = 600; y < 810; y++)
  for (let x = 1040; x < 1160; x++) {
    const i = y * w + x;
    if (background(i)) outside[i] = 1;
  }
for (let i = 0; i < n; i++) if (outside[i]) data[i * 4 + 3] = 0;

// 연결 성분으로 일곱 시설을 분리하므로 서로 다른 크기/높이가 셀을 침범하지 않는다.
const labels = new Int32Array(n),
  components = [];
// 원본 왼쪽 열의 안테나가 이웃 시설에 몇 픽셀 닿아 있어 소유 영역을 나눈다.
const region = (i) => {
  const x = i % w,
    y = Math.floor(i / w);
  if (x >= 520) return 3;
  if (x < 312 && y < 260 && y < 348 - x * 0.5) return 0;
  return y < 550 ? 1 : 2;
};
let label = 0;
for (let i = 0; i < n; i++) {
  if (outside[i] || labels[i]) continue;
  label++;
  head = 0;
  tail = 0;
  queue[tail++] = i;
  labels[i] = label;
  const c = { label, count: 0, x0: w, y0: h, x1: 0, y1: 0 };
  while (head < tail) {
    const p = queue[head++],
      x = p % w,
      y = Math.floor(p / w);
    c.count++;
    c.x0 = Math.min(c.x0, x);
    c.x1 = Math.max(c.x1, x);
    c.y0 = Math.min(c.y0, y);
    c.y1 = Math.max(c.y1, y);
    for (const q of [x ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
      if (q < 0 || q >= n || outside[q] || labels[q] || region(q) !== region(p)) continue;
      labels[q] = label;
      queue[tail++] = q;
    }
  }
  if (c.count > 5_000) components.push(c);
}
if (components.length !== 7)
  throw new Error(`Expected seven cutouts, got ${JSON.stringify(components)}`);
// top park, then fire/police/park, then hospital/school/sports.
const sorted = [
  components.find((c) => c.y1 < 300),
  ...components.filter((c) => c.y0 < 300 && c.y1 >= 300).sort((a, b) => a.x0 - b.x0),
  ...components.filter((c) => c.y0 >= 300).sort((a, b) => a.x0 - b.x0),
];
const cells = [
  [0, 0, 64],
  [0, 64, 128],
  [128, 64, 128],
  [256, 64, 128],
  [0, 192, 192],
  [192, 192, 192],
  [384, 192, 192],
];
const atlas = createCanvas(576, 384),
  out = atlas.getContext('2d');
out.imageSmoothingEnabled = false;
for (let k = 0; k < sorted.length; k++) {
  const c = sorted[k],
    [x, y, size] = cells[k];
  const cw = c.x1 - c.x0 + 1,
    ch = c.y1 - c.y0 + 1;
  const cut = createCanvas(cw, ch),
    cc = cut.getContext('2d'),
    p = cc.createImageData(cw, ch);
  for (let sy = 0; sy < ch; sy++)
    for (let sx = 0; sx < cw; sx++) {
      const i = (c.y0 + sy) * w + c.x0 + sx,
        dst = (sy * cw + sx) * 4;
      if (labels[i] !== c.label) continue;
      p.data.set(data.subarray(i * 4, i * 4 + 4), dst);
    }
  cc.putImageData(p, 0, 0);
  const tips = [];
  for (let sx = 0; sx < cw; sx++) if (p.data[((ch - 1) * cw + sx) * 4 + 3]) tips.push(sx);
  const tip = (tips[0] + tips[tips.length - 1]) / 2;
  // 그림 외곽의 중앙 대신 실제 부지 아래 꼭짓점을 셀 중앙에 고정한다.
  const scale = Math.min((size / 2 - 1) / Math.max(tip, cw - tip), (size - 2) / ch);
  const dw = Math.round(cw * scale),
    dh = Math.round(ch * scale);
  out.drawImage(cut, x + Math.round(size / 2 - (tip * dw) / cw), y + size - dh, dw, dh);
}
mkdirSync('public/sprites', { recursive: true });
writeFileSync('public/sprites/facilities.png', atlas.toBuffer('image/png'));
mkdirSync('.check', { recursive: true });
const preview = createCanvas(1152, 768),
  pc = preview.getContext('2d');
pc.fillStyle = '#28323a';
pc.fillRect(0, 0, 1152, 768);
pc.imageSmoothingEnabled = false;
pc.drawImage(atlas, 0, 0, 1152, 768);
writeFileSync('.check/facilities-preview.png', preview.toBuffer('image/png'));
console.log('Wrote 576x384 RGBA atlas, 7 separate cells', sorted);
