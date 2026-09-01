import type { SaveStatus } from '../net/saveManager';

/**
 * 화면 구석의 저장 상태 표시.
 * 학생이 "지금 저장됐나?" 를 확인할 수 있는 유일한 단서라 항상 떠 있어야 한다.
 */
export class SaveBadge {
  private el: HTMLElement;
  private hideTimer: number | null = null;

  constructor(selector = '#save-status') {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`저장 상태 표시를 찾을 수 없습니다: ${selector}`);
    this.el = el;
  }

  set(status: SaveStatus, message: string): void {
    this.el.dataset.status = status;
    this.el.textContent = message;

    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.el.classList.remove('dim');

    // "저장됨" 은 잠깐 보여주고 흐려진다. 나머지는 계속 보인다.
    if (status === 'saved' || status === 'idle') {
      this.hideTimer = window.setTimeout(() => {
        this.el.classList.add('dim');
      }, 2_000);
    }
  }
}
