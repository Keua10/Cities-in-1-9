import { completionLabel, type ConstructionSystem } from '../sim/construction';
import { FACILITY_SPECS } from '../sim/facilities';

export class ConstructionPanel {
  private lastText = '';
  private element = document.createElement('section');
  private point: { tx: number; ty: number } | null = null;
  constructor(private system: ConstructionSystem) {
    this.element.className = 'building-alert-panel';
    this.element.hidden = true;
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-label', '건설 진행');
    document.body.append(this.element);
    document.addEventListener('close-game-panels', () => this.hide());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide();
    });
  }
  hide(): void {
    this.point = null;
    this.element.hidden = true;
  }
  show(tx: number, ty: number): boolean {
    if (!this.system.at(tx, ty)) {
      this.hide();
      return false;
    }
    this.point = { tx, ty };
    this.update();
    return true;
  }
  update(): void {
    if (!this.point) return;
    const job = this.system.at(this.point.tx, this.point.ty);
    const text = document.createElement('p');
    const progress = job
      ? Math.min(
          100,
          Math.floor(((this.system.elapsed - job.started) / (job.finishes - job.started)) * 100),
        )
      : 100;
    text.textContent = job
      ? `${FACILITY_SPECS[job.kind].name} 공사 중 · ${progress}% · 완공 예정 ${completionLabel(job.finishes)} (왼쪽 아래 생활 시계 기준). 공사 중에는 가동되지 않습니다. 철거 도구로 공사를 취소할 수 있으며 공사비는 반환되지 않습니다.`
      : '건설이 완료되었습니다.';
    if (text.textContent === this.lastText && !this.element.hidden) return;
    this.lastText = text.textContent;
    this.element.replaceChildren();
    const bar = document.createElement('progress');
    bar.max = 100;
    bar.value = progress;
    const close = document.createElement('button');
    close.textContent = '닫기';
    close.onclick = () => this.hide();
    this.element.append(text, bar, close);
    this.element.hidden = false;
  }
}
