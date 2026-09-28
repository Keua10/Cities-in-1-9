import { ALERT_LABELS } from '../sim/environment';
import type { AlertGroup } from '../render/alertLayout';

/** An alert click only explains problems; it never selects the land behind the icon. */
export class AlertPanel {
  private readonly element = document.createElement('section');
  constructor() {
    this.element.className = 'building-alert-panel';
    this.element.hidden = true;
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-label', '건물 문제');
    document.body.append(this.element);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide();
    });
    document.addEventListener('close-game-panels', () => this.hide());
  }
  hide(): void {
    this.element.hidden = true;
  }
  show(group: AlertGroup): void {
    this.element.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = group.count > 1 ? `주변 건물 ${group.count}채의 문제` : '이 건물의 문제';
    const close = document.createElement('button');
    close.textContent = '닫기';
    close.addEventListener('click', () => this.hide());
    const list = document.createElement('ul');
    for (const alert of group.alerts) {
      const item = document.createElement('li');
      item.textContent = ALERT_LABELS[alert];
      list.append(item);
    }
    this.element.append(title, close, list);
    this.element.hidden = false;
    close.focus({ preventScroll: true });
  }
}
