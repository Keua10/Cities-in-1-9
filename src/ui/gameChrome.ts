import { decorateGameIcons } from './gameIcons';
import type { Camera } from '../core/camera';
import type { Tools } from './tools';
import type { MacroSim } from '../sim/macro';
import type { UtilityMode } from '../render/utilityLayer';

export function bindGameChrome(camera: Camera, tools: Tools, center: () => void) {
  decorateGameIcons();
  const ids = ['hud', 'city-panel', 'toolbar', 'map-layers'];
  const panels = ids.map((id) => document.getElementById(id)!);
  let speed = 1;
  let lastPaint = -Infinity;
  const setText = (id: string, text: string) => {
    const el = document.getElementById(id)!;
    if (el.textContent !== text) el.textContent = text;
  };
  const closePanels = () => {
    panels.forEach((p) => {
      p.hidden = true;
    });
    document
      .querySelectorAll('[data-panel], #btn-city-info')
      .forEach((b) => b.setAttribute('aria-expanded', 'false'));
  };
  const openPanel = (id: string, force = false) => {
    const p = document.getElementById(id)!;
    const open = force || p.hidden;
    closePanels();
    document.dispatchEvent(new Event('close-build-palette'));
    document.dispatchEvent(new Event('close-transport-panel'));
    if (open) {
      document.body.classList.remove('clean-view');
      p.hidden = false;
      document
        .querySelectorAll(`[data-panel="${id}"]${id === 'city-panel' ? ', #btn-city-info' : ''}`)
        .forEach((b) => b.setAttribute('aria-expanded', 'true'));
    }
  };
  for (const p of panels) {
    if (p.id === 'hud' || p.id === 'city-panel') {
      const head = document.createElement('header');
      head.className = 'panel-heading';
      head.innerHTML = `<b>${p.id === 'hud' ? '건물 정보 · 시설 찾기' : '도시 통계'}</b><button data-close-panel aria-label="${p.id === 'hud' ? '건물 정보' : '도시 통계'} 닫기">×</button>`;
      p.prepend(head);
    }
  }
  document.querySelectorAll<HTMLButtonElement>('[data-panel]').forEach((b) => {
    b.setAttribute('aria-controls', b.dataset.panel!);
    b.setAttribute('aria-expanded', 'false');
    b.addEventListener('click', () => openPanel(b.dataset.panel!));
  });
  document
    .getElementById('btn-city-info')!
    .addEventListener('click', () => openPanel('city-panel'));
  document
    .querySelectorAll('[data-close-panel]')
    .forEach((b) => b.addEventListener('click', closePanels));
  document.addEventListener('close-game-panels', closePanels);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanels();
  });
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-overlay]')) {
    b.setAttribute('aria-pressed', String(b.dataset.overlay === tools.inspectMode));
    b.addEventListener('click', () => {
      tools.setTool('select');
      tools.inspectMode = b.dataset.overlay as UtilityMode;
      document
        .querySelectorAll<HTMLButtonElement>('[data-overlay]')
        .forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      closePanels();
    });
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
    b.addEventListener('click', () => {
      speed = Number(b.dataset.speed);
      document
        .querySelectorAll<HTMLButtonElement>('[data-speed]')
        .forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      setText('speed-label', speed === 0 ? '정지' : `${speed}×`);
    });
  }
  document
    .getElementById('zoom-in')!
    .addEventListener('click', () => camera.zoomAt(camera.screenW / 2, camera.screenH / 2, 1.25));
  document
    .getElementById('zoom-out')!
    .addEventListener('click', () => camera.zoomAt(camera.screenW / 2, camera.screenH / 2, 0.8));
  document.getElementById('map-home')!.addEventListener('click', center);
  return {
    closePanels,
    showInspection() {
      openPanel('hud', true);
    },
    get speed() {
      return speed;
    },
    update(now: number, sim: MacroSim) {
      if (now - lastPaint < 250) return;
      lastPaint = now;
      setText('strip-pop', Math.round(sim.stats.population).toLocaleString('ko-KR'));
      setText('strip-occupancy', `${Math.round(sim.stats.occupancy * 100)}%`);
      setText('strip-level', `Lv.${sim.cityLevel}`);
      setText('strip-money', `₩${Math.round(sim.money).toLocaleString('ko-KR')}`);
      const net = Math.round(sim.stats.dailyIncome - sim.financeEstimate().upkeep);
      setText('strip-income', `${net >= 0 ? '+' : ''}${net.toLocaleString('ko-KR')} /일`);
      document.getElementById('strip-income')!.classList.toggle('negative', net < 0);
      setText('strip-date', `${sim.day}일차 ${String(sim.hourOfDay).padStart(2, '0')}:00`);
      setText('game-notice', tools.activeMessage(now));
    },
  };
}
