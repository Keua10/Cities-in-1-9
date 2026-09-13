import { TILE_HW, TILE_HH } from '../../src/core/constants';
import { tileToWorldX, tileToWorldY } from '../../src/core/iso';

const ids = [
  { name: '기존 저택', path: '/sprites/candidates/residential-l3-a.png' },
  { name: '바닥 수정 후보 v1', path: '/sprites/review/residential-l3-a-footprint-v1.png' },
];
let showGrid = true,
  zoom = 2;
const cards = await Promise.all(
  ids.map(async ({ name, path }) => {
    const image = new Image();
    image.src = path;
    await image.decode();
    const article = document.createElement('article'),
      title = document.createElement('h2'),
      canvas = document.createElement('canvas'),
      meta = document.createElement('p');
    title.textContent = name;
    meta.className = 'meta';
    article.append(title, canvas, meta);
    document.querySelector('main')!.append(article);
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
    canvas.width = 256 * zoom;
    canvas.height = 240 * zoom;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.scale(zoom, zoom);
    ctx.fillStyle = '#294638';
    ctx.fillRect(0, 0, 256, 240);
    const ox = 128,
      oy = 111;
    for (let sum = -4; sum <= 12; sum++)
      for (let tx = -3; tx <= 6; tx++) {
        const ty = sum - tx;
        if (ty < -3 || ty > 6) continue;
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
    // Same 192px cell placement as StructureMesh: front tile + TILE_HH + 1px gutter.
    const bottom = oy + tileToWorldY(2, 2) + TILE_HH + 1;
    ctx.drawImage(image, ox - 96, bottom - 192);
    if (showGrid) {
      ctx.beginPath();
      ctx.moveTo(ox, oy - TILE_HH);
      ctx.lineTo(ox + 96, oy + 32);
      ctx.lineTo(ox, oy + 80);
      ctx.lineTo(ox - 96, oy + 32);
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
render();
