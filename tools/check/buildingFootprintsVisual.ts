import { tileToWorldX, tileToWorldY } from '../../src/core/iso';
import { BUILDING_NAMES } from '../../src/render/buildingArt';

interface Entry {
  id: string;
  zone: number;
  level: number;
  variant: number;
  mode: string;
  colors: number;
}
const entries: Entry[] = await (await fetch('/sprites/aligned/manifest.json')).json();
entries.sort((a, b) => a.zone - b.zone || a.level - b.level || a.variant - b.variant);
const select = document.querySelector<HTMLSelectElement>('#building')!;
let repeated = true,
  grid = false,
  zoom = 1,
  revision = 0;
const cache = new Map<string, Promise<HTMLImageElement>>();
function load(path: string) {
  if (!cache.has(path))
    cache.set(
      path,
      (async () => {
        const image = new Image();
        image.src = path;
        await image.decode();
        return image;
      })(),
    );
  return cache.get(path)!;
}
const name = (e: Entry) =>
  `${['주거', '상업', '공업'][e.zone]} L${e.level} ${String.fromCharCode(65 + e.variant)} · ${BUILDING_NAMES[e.zone][e.level - 1][e.variant]}`;
for (const entry of entries) {
  const option = document.createElement('option');
  option.value = entry.id;
  option.textContent = name(entry);
  select.append(option);
  const button = document.createElement('button'),
    holder = document.createElement('div'),
    image = document.createElement('img'),
    label = document.createElement('span');
  holder.className = 'thumb';
  image.src = `/sprites/aligned/${entry.id}.png`;
  image.alt = name(entry);
  holder.append(image);
  label.textContent = name(entry);
  button.append(holder, label);
  button.onclick = () => {
    select.value = entry.id;
    void render();
    window.scrollTo({ top: 0 });
  };
  document.querySelector('#catalog')!.append(button);
}
const requestedId = new URLSearchParams(location.search).get('id');
select.value = entries.some((e) => e.id === requestedId) ? requestedId! : 'commercial-l3-a';
async function render() {
  const current = ++revision,
    e = entries.find((v) => v.id === select.value)!;
  const images = await Promise.all(
    ['candidates', 'aligned'].map((folder) => load(`/sprites/${folder}/${e.id}.png`)),
  );
  if (current !== revision) return;
  const n = e.level,
    s = n * 64,
    anchors = repeated
      ? [
          [0, 0],
          [n, 0],
          [n * 2, 0],
          [0, n],
          [n, n],
          [n * 2, n],
        ]
      : [[0, 0]];
  anchors.sort((a, b) => a[0] + a[1] - b[0] - b[1]);
  const width = repeated ? 512 : 256,
    height = repeated ? 352 : 256,
    ox = repeated ? 208 : 128,
    oy = repeated ? 122 : 142;
  images.forEach((image, index) => {
    const canvas = document.querySelector<HTMLCanvasElement>(index ? '#after' : '#before')!;
    canvas.width = width * zoom;
    canvas.height = height * zoom;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.scale(zoom, zoom);
    ctx.fillStyle = '#294638';
    ctx.fillRect(0, 0, width, height);
    for (let sum = -12; sum < 30; sum++)
      for (let tx = -10; tx < 20; tx++) {
        const ty = sum - tx,
          x = ox + tileToWorldX(tx, ty),
          y = oy + tileToWorldY(tx, ty);
        ctx.beginPath();
        ctx.moveTo(x, y - 16);
        ctx.lineTo(x + 32, y);
        ctx.lineTo(x, y + 16);
        ctx.lineTo(x - 32, y);
        ctx.closePath();
        ctx.fillStyle = sum % 2 ? '#638b52' : '#698f55';
        ctx.fill();
        ctx.strokeStyle = '#4e7446';
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }
    for (const [tx, ty] of anchors) {
      const x = ox + tileToWorldX(tx, ty),
        y = oy + tileToWorldY(tx, ty),
        bottom = y + tileToWorldY(n - 1, n - 1) + 17;
      ctx.drawImage(image, x - s / 2, bottom - s);
    }
    if (grid)
      for (const [tx, ty] of anchors) {
        const x = ox + tileToWorldX(tx, ty),
          y = oy + tileToWorldY(tx, ty),
          sideY = y + (n - 1) * 16;
        ctx.beginPath();
        ctx.moveTo(x, y - 16);
        ctx.lineTo(x + s / 2, sideY);
        ctx.lineTo(x, y + (2 * n - 1) * 16);
        ctx.lineTo(x - s / 2, sideY);
        ctx.closePath();
        ctx.strokeStyle = '#74ffe5';
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }
  });
  const method =
    e.mode === 'approved-mansion-v2'
      ? '승인한 저택 v2'
      : e.mode === 'restored-clipped-source'
        ? '잘린 원본 복원 + 원본 팔레트 + 바닥 보정'
        : '원본 RGB 유지 · 픽셀 좌표 보정';
  document.querySelector('#status')!.textContent =
    `${name(e)} · ${s}×${s}px · ${method} · 원본 팔레트 밖 색 0개`;
}
select.onchange = () => void render();
document.querySelector<HTMLButtonElement>('#repeat')!.onclick = (e) => {
  repeated = !repeated;
  (e.currentTarget as HTMLButtonElement).textContent = repeated
    ? '한 채 보기'
    : '연속 배치 6채 보기';
  void render();
};
document.querySelector<HTMLButtonElement>('#grid')!.onclick = (e) => {
  grid = !grid;
  (e.currentTarget as HTMLButtonElement).textContent = grid ? '부지 경계 숨기기' : '부지 경계 표시';
  void render();
};
document.querySelector<HTMLSelectElement>('#zoom')!.onchange = (e) => {
  zoom = Number((e.currentTarget as HTMLSelectElement).value);
  void render();
};
await render();
