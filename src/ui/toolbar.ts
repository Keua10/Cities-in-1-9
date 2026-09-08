import { signOut } from '../net/auth';
import type { AnySaveManager } from '../net/saveManager';
import type { WorldRenderer } from '../render/worldRenderer';

interface ToolbarDeps {
  centerCamera: () => void;
  renderer: WorldRenderer;
  saver: AnySaveManager;
  loggedIn: boolean;
  /** 도시를 통째로 지우고 새 대도시를 심는다. 되돌릴 수 없다. */
  resetCity: () => Promise<void>;
}

export function bindToolbar(deps: ToolbarDeps): void {
  const { renderer } = deps;
  const fogBtn = document.getElementById('btn-fog');
  const gridBtn = document.getElementById('btn-grid');
  const centerBtn = document.getElementById('btn-center');
  const saveBtn = document.getElementById('btn-save');
  const resetBtn = document.getElementById('btn-reset');
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

  saveBtn?.addEventListener('click', () => {
    void deps.saver.saveNow();
  });

  resetBtn?.addEventListener('click', () => {
    if (
      !window.confirm('지금 도시를 전부 지우고 새 도시를 만듭니다. 되돌릴 수 없습니다. 계속할까요?')
    ) {
      return;
    }
    resetBtn.setAttribute('disabled', '');
    resetBtn.textContent = '만드는 중…';
    void deps.resetCity();
  });

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
