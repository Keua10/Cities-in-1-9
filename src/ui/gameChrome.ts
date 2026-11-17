import { worldDayNumber } from '../sim/time';
import { WEEKDAY_NAMES, type DaytimeSnapshot } from '../sim/time';
import { decorateGameIcons } from './gameIcons';
import { formatMoney } from './money';
import { reducedMotion } from '../core/motion';
import { PEACE_SPEED } from '../sim/simConstants';
import type { Camera } from '../core/camera';
import type { Tools } from './tools';
import type { MacroSim } from '../sim/macro';
import type { UtilityMode } from '../render/utilityLayer';

export function bindGameChrome(camera: Camera, tools: Tools, center: () => void) {
  decorateGameIcons();
  const ids = ['hud', 'city-panel', 'toolbar', 'map-layers'];
  const panels = ids.map((id) => document.getElementById(id)!);
  let lastPaint = -Infinity;
  const setText = (id: string, text: string) => {
    const el = document.getElementById(id)!;
    if (el.textContent !== text) el.textContent = text;
  };
  /** 돈 숫자: 바뀌면 0.45초 동안 굴러가듯 따라가고, 오르면 초록·내리면 붉게 잠깐. */
  const money = { shown: NaN, from: 0, to: 0, at: 0, raf: 0, flash: 0 };
  const rollMoney = (target: number) => {
    const el = document.getElementById('strip-money')!;
    if (target === money.to && !Number.isNaN(money.shown)) return;
    if (Number.isNaN(money.shown) || reducedMotion() || Math.abs(target - money.shown) < 1) {
      money.shown = money.to = target;
      setText('strip-money', formatMoney(target, true));
      return;
    }
    el.classList.toggle('up', target > money.shown);
    el.classList.toggle('down', target < money.shown);
    clearTimeout(money.flash);
    money.flash = window.setTimeout(() => el.classList.remove('up', 'down'), 700);
    money.from = money.shown;
    money.to = target;
    money.at = performance.now();
    cancelAnimationFrame(money.raf);
    const step = () => {
      const k = Math.min(1, (performance.now() - money.at) / 450);
      const e = 1 - (1 - k) ** 3;
      money.shown = money.from + (money.to - money.from) * e;
      setText('strip-money', formatMoney(Math.round(money.shown), true));
      if (k < 1) money.raf = requestAnimationFrame(step);
    };
    step();
  };
  /** 알림 띠: 글이 사라질 때 바로 지우지 않고 0.2초 내려가며 흐려진 뒤 지운다. */
  let noticeOut = 0;
  const setNotice = (text: string) => {
    const el = document.getElementById('game-notice')!;
    if (text) {
      clearTimeout(noticeOut);
      noticeOut = 0;
      el.classList.remove('out');
      setText('game-notice', text);
    } else if (el.textContent && !noticeOut) {
      if (reducedMotion()) {
        el.textContent = '';
        return;
      }
      el.classList.add('out');
      noticeOut = window.setTimeout(() => {
        el.textContent = '';
        el.classList.remove('out');
        noticeOut = 0;
      }, 200);
    }
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
    /** 접속 중에는 일시정지·배속 없이 항상 평시 배속으로 흐른다. */
    get speed() {
      return PEACE_SPEED;
    },
    update(now: number, sim: MacroSim, life: DaytimeSnapshot) {
      if (now - lastPaint < 250) return;
      lastPaint = now;
      setText('strip-pop', Math.round(sim.stats.population).toLocaleString('ko-KR'));
      setText('strip-occupancy', `${Math.round(sim.stats.occupancy * 100)}%`);
      setText('strip-level', `Lv.${sim.cityLevel}`);
      rollMoney(sim.money);
      document.getElementById('strip-money')!.title = formatMoney(sim.money);
      const finance = sim.financeEstimate(sim.incomeMultiplier);
      const net = finance.income - finance.upkeep;
      setText('strip-income', `${formatMoney(net, true, true)} /일`);
      document.getElementById('strip-income')!.title =
        `${formatMoney(net, false, true)} /일 · 생활 하루(실제 5분)에 걸쳐 수입과 유지비가 일정하게 반영됩니다`;
      document.getElementById('strip-income')!.classList.toggle('negative', net < 0);
      setText(
        'strip-date',
        `${worldDayNumber(life)}일차 ${WEEKDAY_NAMES[life.weekday]} ${String(life.hourOfDay).padStart(2, '0')}:${String(life.minuteOfDay % 60).padStart(2, '0')} ${life.isDay ? '낮' : '밤'}`,
      );
      setNotice(tools.activeMessage(now));
      const boost = sim.startBoostLeftMs;
      const badge = document.getElementById('start-boost')!;
      badge.hidden = boost <= 0;
      if (boost > 0) {
        const s = Math.ceil(boost / 1000);
        setText('start-boost-time', `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
      }
    },
  };
}
