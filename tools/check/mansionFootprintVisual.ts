import { TILE_HW, TILE_HH } from '../../src/core/constants';
import { tileToWorldX, tileToWorldY } from '../../src/core/iso';

const ids = [
  { name: '기존 저택', path: '/sprites/candidates/residential-l3-a.png' },
  { name: '원본 팔레트 후보 v2', path: '/sprites/review/residential-l3-a-footprint-v2.png' },
];
let showGrid = true,
  zoom = 2,
  repeated = false;
const cards = await Promise.all(
  ids.map(async ({ name, path }) => {
    const article = document.createElement('article'),
      title = document.createElement('h2'),
      canvas = document.createElement('canvas'),
      meta = document.createElement('p');
    title.textContent = name;
    meta.className = 'meta';
    article.append(title, canvas, meta);
    document.querySelector('main')!.append(article);
    const image = new Image();
    image.src = path;
    await image.decode();
    const source = document.createElement('canvas');
    source.width = source.height = 192;
    const c = source.getContext('2d')!;
    c.drawImage(image, 0, 0);
    const pixels = c.getImageData(0, 0, 192, 192).data;
    const edge = (x: number) => {
      for (let y = 191; y >= 0; y--) if (pixels[(y * 192 + x) * 4 + 3]) return y;
      return -1;
    };
    const slope = (a: number, b: number) => {
      const points = Array.from({ length: b - a + 1 }, (_, i) => [a + i, edge(a + i)]),
        mx = (a + b) / 2,
        my = points.reduce((n, p) => n + p[1], 0) / points.length;
      return (
        points.reduce((n, p) => n + (p[0] - mx) * (p[1] - my), 0) /
        points.reduce((n, p) => n + (p[0] - mx) ** 2, 0)
      );
    };
    meta.textContent = `${image.width}×${image.height} · 전면 외곽 기울기 ${Math.abs(slope(16, 76)).toFixed(3)} / ${Math.abs(slope(116, 176)).toFixed(3)} · 게임 기준 0.500`;
    return { image, canvas };
  }),
);
function render() {
  for (const { image, canvas } of cards) {
    const width = repeated ? 512 : 256,
      height = repeated ? 336 : 240;
    canvas.width = width * zoom;
    canvas.height = height * zoom;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.scale(zoom, zoom);
    ctx.fillStyle = '#294638';
    ctx.fillRect(0, 0, width, height);
    const ox = repeated ? 208 : 128,
      oy = repeated ? 90 : 111;
    for (let sum = -6; sum <= 20; sum++)
      for (let tx = -3; tx <= 11; tx++) {
        const ty = sum - tx;
        if (ty < -3 || ty > 8) continue;
        const x = ox + tileToWorldX(tx, ty),
          y = oy + tileToWorldY(tx, ty);
        ctx.beginPath();
        ctx.moveTo(x, y - TILE_HH);
        ctx.lineTo(x + TILE_HW, y);
        ctx.lineTo(x, y + TILE_HH);
        ctx.lineTo(x - TILE_HW, y);
        ctx.closePath();
        ctx.fillStyle = (tx + ty) % 2 ? '#638b52' : '#698f55';
        ctx.fill();
        ctx.strokeStyle = '#4e7446';
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }
    const anchors = repeated
      ? [
          [0, 0],
          [3, 0],
          [6, 0],
          [0, 3],
          [3, 3],
          [6, 3],
        ]
      : [[0, 0]];
    anchors.sort((a, b) => a[0] + a[1] - b[0] - b[1]);
    for (const [tx, ty] of anchors) {
      // Same placement as StructureMesh, including the 1px bottom gutter.
      const x = ox + tileToWorldX(tx, ty),
        y = oy + tileToWorldY(tx, ty);
      const bottom = y + tileToWorldY(2, 2) + TILE_HH + 1;
      ctx.drawImage(image, x - 96, bottom - 192);
    }
    if (showGrid)
      for (const [tx, ty] of anchors) {
        const x = ox + tileToWorldX(tx, ty),
          y = oy + tileToWorldY(tx, ty);
        ctx.beginPath();
        ctx.moveTo(x, y - TILE_HH);
        ctx.lineTo(x + 96, y + 32);
        ctx.lineTo(x, y + 80);
        ctx.lineTo(x - 96, y + 32);
        ctx.closePath();
        ctx.strokeStyle = '#74ffe5';
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }
  }
}
document.querySelector<HTMLButtonElement>('#grid')!.onclick = () => {
  showGrid = !showGrid;
  document.querySelector('#grid')!.textContent = showGrid ? '부지 경계 숨기기' : '부지 경계 표시';
  render();
};
document.querySelector<HTMLSelectElement>('#zoom')!.onchange = (e) => {
  zoom = Number((e.target as HTMLSelectElement).value);
  render();
};
document.querySelector<HTMLButtonElement>('#layout')!.onclick = () => {
  repeated = !repeated;
  zoom = repeated ? 1 : 2;
  document.querySelector<HTMLSelectElement>('#zoom')!.value = String(zoom);
  document.querySelector('#layout')!.textContent = repeated ? '한 채 보기' : '연속 배치 6채 보기';
  render();
};
render();
