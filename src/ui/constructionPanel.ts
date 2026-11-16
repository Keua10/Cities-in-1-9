import { constructionSeconds, formatDuration, type ConstructionSystem } from '../sim/construction';
import { FACILITY_SPECS } from '../sim/facilities';
import { formatMoney } from './money';

/** 완공 예정 실제 시각. 오늘이면 "오후 2:14", 아니면 "11월 17일 오전 9:05". */
export function finishClock(at: number, now = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return time;
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${time}`;
}

/**
 * 공사 중인 시설을 누르면 뜨는 창.
 * 전체 공사 기간 · 남은 시간 · 완공 예정 시각 · 진행률 · 공사 취소(두 번 눌러 확정).
 */
export class ConstructionPanel {
  /** "공사 취소" 를 확정했을 때. main 이 tools.cancelConstruction 을 물린다. */
  onCancel: ((tx: number, ty: number) => boolean) | null = null;
  private element = document.createElement('section');
  private point: { tx: number; ty: number } | null = null;
  private armed = false;
  private lastKey = '';
  private title = document.createElement('h3');
  private facts = document.createElement('dl');
  private bar = document.createElement('progress');
  private note = document.createElement('p');
  private cancel = document.createElement('button');
  private close = document.createElement('button');

  constructor(private system: ConstructionSystem) {
    this.element.className = 'building-alert-panel construction-panel';
    this.element.hidden = true;
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-label', '공사 진행');
    this.bar.max = 100;
    this.note.className = 'construction-note';
    this.cancel.className = 'construction-cancel';
    this.close.textContent = '닫기';
    this.close.onclick = () => this.hide();
    this.cancel.onclick = () => {
      if (!this.point) return;
      if (!this.armed) {
        this.armed = true;
        this.lastKey = '';
        this.update();
        return;
      }
      const { tx, ty } = this.point;
      this.onCancel?.(tx, ty);
      this.hide();
    };
    const actions = document.createElement('div');
    actions.className = 'construction-actions';
    actions.append(this.cancel, this.close);
    this.element.append(this.title, this.facts, this.bar, this.note, actions);
    document.body.append(this.element);
    document.addEventListener('close-game-panels', () => this.hide());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide();
    });
  }
  hide(): void {
    this.point = null;
    this.armed = false;
    this.lastKey = '';
    this.element.hidden = true;
  }
  show(tx: number, ty: number): boolean {
    if (!this.system.at(tx, ty)) {
      this.hide();
      return false;
    }
    const same =
      this.point && this.system.at(this.point.tx, this.point.ty) === this.system.at(tx, ty);
    if (!same) this.armed = false;
    this.point = { tx, ty };
    this.lastKey = '';
    this.update();
    return true;
  }
  update(): void {
    if (!this.point) return;
    const job = this.system.at(this.point.tx, this.point.ty);
    if (!job) {
      this.hide();
      return;
    }
    const now = Date.now();
    const left = this.system.remainingMs(job);
    const progress = Math.floor(this.system.progress(job) * 100);
    const leftText = formatDuration(left / 1000);
    const finishText = finishClock(now + left, now);
    // 1초 단위로만 다시 그린다(버튼이 매 프레임 새로 생기지 않게).
    const key = `${progress}|${leftText}|${finishText}|${this.armed}`;
    if (key === this.lastKey && !this.element.hidden) return;
    this.lastKey = key;
    this.title.textContent = `🏗 ${FACILITY_SPECS[job.kind].name} 공사 중`;
    const rows: [string, string][] = [
      ['전체 공사 기간', formatDuration(constructionSeconds(job.kind))],
      ['남은 시간', leftText],
      ['완공 예정', finishText],
      ['진행', `${progress}%`],
    ];
    this.facts.replaceChildren(
      ...rows.map(([k, v]) => {
        const row = document.createElement('div');
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = k;
        dd.textContent = v;
        row.append(dt, dd);
        return row;
      }),
    );
    this.bar.value = progress;
    this.note.textContent = this.armed
      ? `정말 취소할까요? 공사비 ${formatMoney(job.cost, true)}은 돌려받지 못합니다.`
      : (this.system.boosted ? '🔥 스타트 버닝 중이라 10배로 지어지고 있습니다. ' : '') +
        '공사는 접속하지 않아도 실제 시간으로 계속됩니다. 공사 중에는 가동되지 않습니다.';
    this.note.classList.toggle('warn', this.armed);
    this.cancel.textContent = this.armed ? '취소 확정' : '공사 취소';
    this.cancel.classList.toggle('armed', this.armed);
    this.element.hidden = false;
  }
}
