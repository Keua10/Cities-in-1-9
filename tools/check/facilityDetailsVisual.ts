import { tileToWorldX, tileToWorldY } from '../../src/core/iso';
interface Entry {
  id: string;
  kind: number;
  name: string;
  span: number;
  size: number;
  colors: number;
}
const entries: Entry[] = await (await fetch('/sprites/facilities-detailed/manifest.json')).json();
const select = document.querySelector<HTMLSelectElement>('#facility')!;
const mode = document.querySelector<HTMLSelectElement>('#mode')!;
const zoomSelect = document.querySelector<HTMLSelectElement>('#zoom')!;
let grid = true,
  revision = 0;
const cache = new Map<string, Promise<HTMLImageElement>>();
function load(path: string) {
  if (!cache.has(path))
    cache.set(
      path,
      (async () => {
        const i = new Image();
        i.src = path;
        await i.decode();
        return i;
      })(),
    );
  return cache.get(path)!;
}
for (const e of entries) {
  const option = document.createElement('option');
  option.value = e.id;
  option.textContent = `${e.name} · ${e.span}×${e.span}`;
  select.append(option);
  const button = document.createElement('button'),
    image = document.createElement('img'),
    label = document.createElement('span');
  image.src = `/sprites/facilities-detailed/${e.id}.png`;
  image.alt = e.name;
  image.width = image.height = e.size;
  label.textContent = `${e.name} · ${e.size}px`;
  button.append(image, label);
  button.onclick = () => {
    select.value = e.id;
    void render();
    window.scrollTo({ top: 0 });
  };
  document.querySelector('#catalog')!.append(button);
}
const requested = new URLSearchParams(location.search).get('id');
select.value = entries.some((e) => e.id === requested) ? requested! : 'fire-station';
async function render() {
  const rev = ++revision,
    e = entries.find((e) => e.id === select.value)!;
  const n = e.span,
    s = n * 64,
    zoom = Number(zoomSelect.value);
  const before = await load(`/sprites/facilities-detailed/previous/${e.id}.png`),
    after = await load(`/sprites/facilities-detailed/${e.id}.png`);
  const home = await load('/sprites/aligned/residential-l1-a.png'),
    shop = await load('/sprites/aligned/commercial-l1-a.png');
  if (rev !== revision) return;
  const places: { x: number; y: number; n: number; image?: HTMLImageElement }[] = [
    { x: 0, y: 0, n },
  ];
  if (mode.value === 'mixed')
    places.push(
      { x: n + 1, y: 0, n: 1, image: home },
      { x: n + 1, y: 2, n: 1, image: shop },
      { x: 0, y: n + 1, n: 1, image: home },
      { x: 2, y: n + 1, n: 1, image: shop },
    );
  if (mode.value === 'repeat') places.push({ x: n, y: 0, n }, { x: 0, y: n, n });
  places.sort((a, b) => a.x + a.y + 2 * a.n - (b.x + b.y + 2 * b.n));
  const rects = places.map((p) => {
    const bottom = tileToWorldY(p.x + p.n - 1, p.y + p.n - 1) + 16 + (p.image ? 1 : 0);
    return { x: tileToWorldX(p.x, p.y) - p.n * 32, y: bottom - p.n * 64, w: p.n * 64, h: p.n * 64 };
  });
  const minX = Math.min(...rects.map((r) => r.x)) - 40,
    minY = Math.min(...rects.map((r) => r.y)) - 20;
  const w = Math.ceil(Math.max(...rects.map((r) => r.x + r.w)) - minX + 40),
    h = Math.ceil(Math.max(...rects.map((r) => r.y + r.h)) - minY + 32);
  [before, after].forEach((image, index) => {
    const c = document.querySelector<HTMLCanvasElement>(index ? '#after' : '#before')!;
    c.width = w;
    c.height = h;
    c.style.width = `${w * zoom}px`;
    c.style.height = `${h * zoom}px`;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#52774c';
    ctx.fillRect(0, 0, w, h);
    for (let ty = -12; ty < 30; ty++)
      for (let tx = -12; tx < 30; tx++) {
        const x = tileToWorldX(tx, ty) - minX,
          y = tileToWorldY(tx, ty) - minY;
        ctx.beginPath();
        ctx.moveTo(x, y - 16);
        ctx.lineTo(x + 32, y);
        ctx.lineTo(x, y + 16);
        ctx.lineTo(x - 32, y);
        ctx.closePath();
        ctx.fillStyle = (tx + ty) % 2 ? '#668950' : '#688c52';
        ctx.fill();
        ctx.strokeStyle = '#547444';
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }
    places.forEach((p, i) => ctx.drawImage(p.image ?? image, rects[i].x - minX, rects[i].y - minY));
    if (grid)
      for (const p of places) {
        if (p.image) continue;
        const x = tileToWorldX(p.x, p.y) - minX,
          y = tileToWorldY(p.x, p.y) - minY;
        ctx.beginPath();
        ctx.moveTo(x, y - 16);
        ctx.lineTo(x + p.n * 32, y + (p.n - 1) * 16);
        ctx.lineTo(x, y + (p.n * 2 - 1) * 16);
        ctx.lineTo(x - p.n * 32, y + (p.n - 1) * 16);
        ctx.closePath();
        ctx.strokeStyle = '#77ffde';
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }
  });
  document.querySelector('#status')!.textContent =
    `${e.name} · ${s}×${s}px · ${e.colors}색 · 2:1 바닥 · 도트 보간 없음`;
  document.querySelector<HTMLAnchorElement>('#scene')!.href =
    `./facilityDetailsScene.html?kind=${e.kind}`;
}
select.onchange = mode.onchange = zoomSelect.onchange = () => void render();
document.querySelector<HTMLButtonElement>('#grid')!.onclick = (ev) => {
  grid = !grid;
  (ev.currentTarget as HTMLButtonElement).textContent = grid
    ? '부지 경계 숨기기'
    : '부지 경계 표시';
  void render();
};
await render();
