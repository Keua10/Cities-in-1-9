import type { Tools } from './tools';
import { formatMoney } from './money';
import {
  BUILD_CATEGORIES,
  BUILD_ITEMS,
  type BuildCategory,
  type BuildItem,
} from './constructionCatalog';
import { gameIcon } from './gameIcons';
import { facilityCellSize, paintFacilityThumbnail } from '../render/facilityAtlas';
import { FACILITY_SPECS } from '../sim/facilities';

/** One category tap, one item tap, then placement. No nested category dialogs. */
export function bindConstructionMenu(tools: Tools, onChange?: () => void): void {
  const rail = document.getElementById('tools')!;
  const panel = document.createElement('section');
  panel.id = 'build-palette';
  panel.className = 'game-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', '건설 항목');
  panel.innerHTML =
    '<header><div><b id="build-title">건설</b><small id="build-hint"></small></div><button aria-label="건설 목록 닫기">×</button></header><input type="search" aria-label="건설 항목 검색" placeholder="이름으로 바로 찾기"/><div class="build-cards"></div><p class="build-empty" hidden>일치하는 항목이 없습니다.</p>';
  document.body.append(panel);
  const cards = panel.querySelector<HTMLDivElement>('.build-cards')!;
  const search = panel.querySelector<HTMLInputElement>('input')!;
  let category: BuildCategory | null = null;
  let selected: BuildItem | null = null;
  let opener: HTMLButtonElement | null = null;
  const categoryButtons = new Map<BuildCategory, HTMLButtonElement>();
  const entries = new Map<BuildItem, HTMLButtonElement>();
  const active = document.getElementById('active-build')!;
  const activeLabel = document.getElementById('active-build-label')!;

  const button = (label: string, icon: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = gameIcon(icon) + `<span>${label}</span>`;
    return b;
  };
  const select = button('선택', 'select');
  select.id = 'btn-tool-select';
  rail.append(select);
  const close = (restore = false) => {
    panel.hidden = true;
    for (const b of categoryButtons.values()) b.setAttribute('aria-expanded', 'false');
    if (restore) opener?.focus();
  };
  const sync = () => {
    select.setAttribute('aria-pressed', String(tools.tool === 'select'));
    for (const [c, b] of categoryButtons)
      b.setAttribute('aria-pressed', String(selected?.category === c && tools.tool !== 'select'));
    for (const [item, b] of entries) {
      b.disabled = tools.cityLevel < item.unlock;
      b.setAttribute('aria-pressed', String(selected?.id === item.id));
      b.querySelector('.build-lock')!.textContent = b.disabled ? `Lv.${item.unlock} 해금` : '';
    }
    bulldoze.setAttribute('aria-pressed', String(tools.tool === 'bulldoze'));
    active.hidden = tools.tool === 'select';
    activeLabel.textContent =
      tools.tool === 'metroView'
        ? '지하철 보기 · 역을 눌러 연결 확인'
        : tools.tool === 'bulldoze'
          ? '철거 · 지도를 눌러 제거'
          : selected
            ? `${selected.name} · ${formatMoney(selected.cost, true)} · 지도에 배치`
            : '';
    onChange?.();
  };
  const cancel = () => {
    selected = null;
    tools.setTool('select');
    close();
    sync();
  };
  select.addEventListener('click', cancel);
  document.getElementById('cancel-build')!.addEventListener('click', cancel);
  const filter = () => {
    const q = search.value.replace(/\s/g, '');
    let count = 0;
    for (const [item, b] of entries) {
      b.hidden = q ? !item.name.replace(/\s/g, '').includes(q) : item.category !== category;
      if (!b.hidden) count++;
    }
    panel.querySelector<HTMLElement>('.build-empty')!.hidden = count > 0;
  };
  for (const c of BUILD_CATEGORIES) {
    const b = button(c.name, c.icon);
    b.dataset.category = c.id;
    b.style.setProperty('--category-color', c.color);
    b.setAttribute('aria-controls', panel.id);
    b.setAttribute('aria-expanded', 'false');
    categoryButtons.set(c.id, b);
    rail.append(b);
    b.addEventListener('click', () => {
      const open = panel.hidden || category !== c.id;
      close();
      if (!open) return;
      // Browsing must not leave the previous bulldozer/brush armed behind the palette.
      tools.setTool('select');
      selected = null;
      document.dispatchEvent(new Event('close-game-panels'));
      category = c.id;
      opener = b;
      search.value = '';
      panel.querySelector('#build-title')!.textContent = c.name;
      panel.querySelector('#build-hint')!.textContent = c.hint;
      panel.style.setProperty('--category-color', c.color);
      panel.hidden = false;
      b.setAttribute('aria-expanded', 'true');
      filter();
      sync();
    });
  }
  const bulldoze = button('철거', 'bulldoze');
  bulldoze.id = 'btn-tool-bulldoze';
  bulldoze.style.setProperty('--category-color', '#de9b81');
  rail.append(bulldoze);
  bulldoze.addEventListener('click', () => {
    close();
    selected = null;
    tools.setTool('bulldoze');
    sync();
  });
  for (const item of BUILD_ITEMS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'build-card';
    b.dataset.item = item.id;
    b.setAttribute('aria-label', item.name);
    b.title = item.detail;
    b.innerHTML = `<span class="build-art">${gameIcon(item.icon)}</span><b>${item.name}</b><span class="build-price" title="${formatMoney(item.cost)}">${formatMoney(item.cost, true)}</span><small>${item.detail}</small><span class="build-lock"></span>`;
    if (item.kind !== undefined) {
      const canvas = document.createElement('canvas');
      // Native canvas dimensions come from the actual atlas span, not the displayed card size.
      const specSpan = FACILITY_SPECS[item.kind].span;
      canvas.width = canvas.height = facilityCellSize(specSpan);
      canvas.setAttribute('aria-hidden', 'true');
      b.querySelector('.build-art')!.replaceChildren(canvas);
      void paintFacilityThumbnail(canvas.getContext('2d')!, item.kind);
    }
    b.addEventListener('click', () => {
      if (tools.cityLevel < item.unlock) return;
      selected = item;
      if (item.kind !== undefined) tools.facilityKind = item.kind;
      tools.setTool(item.tool);
      close();
      sync();
    });
    entries.set(item, b);
    cards.append(b);
  }
  search.addEventListener('input', filter);
  panel.querySelector('header button')!.addEventListener('click', () => close(true));
  document.addEventListener('close-build-palette', () => {
    close();
    cancel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    cancel();
    opener?.focus();
  });
  let level = tools.cityLevel;
  window.setInterval(() => {
    if (level !== tools.cityLevel) {
      level = tools.cityLevel;
      sync();
    }
  }, 1000);
  sync();
}
