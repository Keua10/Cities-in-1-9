import { buildingArt, BUILDING_NAMES } from '../../src/render/buildingArt';
import { facilityArt } from '../../src/render/facilityArt';
import { FACILITY_SPECS } from '../../src/sim/facilities';
import type { PixelArt } from '../../src/render/pixelArt';

const gallery = document.getElementById('gallery')!;
let filter = 0,
  zoom = 1;
function card(a: PixelArt, name: string, description: string): void {
  const article = document.createElement('article'),
    canvas = document.createElement('canvas');
  canvas.width = canvas.height = a.size;
  canvas.style.width = canvas.style.height = `${a.size * zoom}px`;
  a.paint(canvas.getContext('2d')!);
  const title = document.createElement('h2');
  title.textContent = name;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = description;
  article.append(canvas, title, meta);
  gallery.append(article);
}
function render(): void {
  gallery.replaceChildren();
  if (filter < 3)
    for (let level = 1; level <= 3; level++)
      for (let v = 0; v < 4; v++)
        card(
          buildingArt(level, filter, v),
          BUILDING_NAMES[filter][level - 1][v],
          `L${level} · ${level}×${level} 타일 · ${level * 64}px 셀`,
        );
  else
    for (const s of FACILITY_SPECS)
      card(facilityArt(s.kind), s.name, `${s.span}×${s.span} 타일 · ${s.span * 64}px 셀`);
  document
    .querySelectorAll<HTMLButtonElement>('[data-filter]')
    .forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.filter) === filter)));
  document
    .querySelectorAll<HTMLButtonElement>('[data-zoom]')
    .forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.zoom) === zoom)));
}
['주거 12종', '상업 12종', '공업 12종', '특수 시설 26종'].forEach((name, i) => {
  const b = document.createElement('button');
  b.textContent = name;
  b.dataset.filter = String(i);
  b.onclick = () => {
    filter = i;
    render();
  };
  document.getElementById('filters')!.append(b);
});
for (const z of [0.5, 1, 2]) {
  const b = document.createElement('button');
  b.textContent = `${z * 100}%`;
  b.dataset.zoom = String(z);
  b.onclick = () => {
    zoom = z;
    render();
  };
  document.getElementById('zoom')!.append(b);
}
render();
