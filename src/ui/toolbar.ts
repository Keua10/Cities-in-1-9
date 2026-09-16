import { signOut } from '../net/auth';
import type { AnySaveManager } from '../net/saveManager';
import type { WorldRenderer } from '../render/worldRenderer';
import { bindAdminPanel, type CityResetMode } from './adminPanel';

interface ToolbarDeps {
  centerCamera: () => void;
  renderer: WorldRenderer;
  saver: AnySaveManager;
  loggedIn: boolean;
  getMoney: () => number;
  setMoney: (amount: number) => Promise<void>;
  /**
   * 도시를 통째로 지우고 다시 시작한다. 되돌릴 수 없다.
   *   'metropolis' — 다 자란 대도시를 심는다.
   *   'empty'      — 빈 땅 + 시작 자금. 학생이 실제로 시작하는 상태다.
   */
  resetCity: (mode: CityResetMode) => Promise<void>;
}

export function bindToolbar(deps: ToolbarDeps): void {
  const { renderer } = deps;
  const fogBtn = document.getElementById('btn-fog');
  const gridBtn = document.getElementById('btn-grid');
  const centerBtn = document.getElementById('btn-center');
  const saveBtn = document.getElementById('btn-save');
  const logoutBtn = document.getElementById('btn-logout');

  fogBtn?.setAttribute('aria-pressed', String(renderer.showFog));
  gridBtn?.setAttribute('aria-pressed', String(renderer.showGrid));

  fogBtn?.addEventListener('click', () => {
    renderer.showFog = !renderer.showFog;
    fogBtn.setAttribute('aria-pressed', String(renderer.showFog));
  });
  gridBtn?.addEventListener('click', () => {
    renderer.showGrid = !renderer.showGrid;
    gridBtn.setAttribute('aria-pressed', String(renderer.showGrid));
    renderer.forceRedraw();
  });
  centerBtn?.addEventListener('click', deps.centerCamera);
  const cleanBtn = document.getElementById('btn-clean-view');
  const cityBtn = document.getElementById('btn-city-info');
  cleanBtn?.addEventListener('click', () => {
    const clean = document.body.classList.toggle('clean-view');
    document.dispatchEvent(new Event('close-game-panels'));
    document.body.classList.remove('city-info-open');
    cityBtn?.setAttribute('aria-expanded', 'false');
    cleanBtn.setAttribute('aria-pressed', String(clean));
    cleanBtn.textContent = clean ? '정보 다시 보기' : '화면 정리';
  });

  saveBtn?.addEventListener('click', () => {
    void deps.saver.saveNow();
  });

  bindAdminPanel(deps);

  if (!deps.loggedIn) {
    logoutBtn?.setAttribute('hidden', '');
    saveBtn?.setAttribute('hidden', '');
  }
  logoutBtn?.addEventListener('click', () => {
    void (async () => {
      await deps.saver.saveNow();
      await signOut();
      location.reload();
    })();
  });
}
