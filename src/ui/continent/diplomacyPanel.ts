import type { PublicCity } from '../../net/publicCities';
import { ALLIANCE_DEPOSITS, BETRAYAL_LOCK_MS } from '../../sim/config/war';
import { PASS_RULE_NAMES, passValid } from '../../sim/military/waters';
import { formatMoney } from '../money';
import type { ContinentMapSource } from '../continentMap';
import type { MapSelection } from './shared';

/**
 * 도시 칸의 외교: 받은 요청(동맹·통과 허가), 다른 도시들의 대규모 전쟁(진영 참가),
 * 고른 도시에 대한 동맹·통과·선전포고.
 */
export class DiplomacyPanel {
  private incomingEl: HTMLElement;
  private openWarsEl: HTMLElement;
  private declareEl: HTMLElement;

  constructor(
    root: HTMLElement,
    private source: ContinentMapSource,
    private sel: MapSelection,
    private cities: () => readonly PublicCity[],
    /** 선전포고 뒤(전쟁 줄을 바로 고친다). */
    private onDeclared: () => void,
  ) {
    this.incomingEl = root.querySelector('.cm-incoming')!;
    this.openWarsEl = root.querySelector('.cm-open-wars')!;
    this.declareEl = root.querySelector('.cm-declare')!;
    const deposit = this.declareEl.querySelector<HTMLSelectElement>('.cm-ally-deposit')!;
    for (const d of ALLIANCE_DEPOSITS) {
      const o = document.createElement('option');
      o.value = String(d);
      o.textContent = d ? `보증금 ${formatMoney(d)}` : '보증금 없음';
      deposit.append(o);
    }
    this.declareEl
      .querySelector('.cm-ally-go')!
      .addEventListener('click', () => void this.allyAction());
    this.declareEl.querySelector('.cm-pass-go')!.addEventListener('click', async () => {
      const them = this.target();
      const ps = this.source.passes;
      if (!them || !ps) return;
      const why = await ps.request(them.uid, them.pass ?? 'open');
      this.source.announce(
        why || (them.pass === 'permit' ? '통과 허가를 요청했습니다' : '통과를 신고했습니다'),
      );
    });
    for (const b of this.declareEl.querySelectorAll<HTMLButtonElement>('button[data-war]'))
      b.addEventListener(
        'click',
        () => void this.declare(b.dataset.war as 'small' | 'surprise' | 'large'),
      );
  }

  /** 고른 다른 도시. */
  private target(): PublicCity | undefined {
    return this.cities().find((c) => c.uid === this.sel.city);
  }

  /** 고른 다른 도시에 대한 동맹·통과·선전포고 칸. */
  renderDeclare(): void {
    const mine = this.source.mine();
    const them = this.target();
    if (!them || them.uid === mine.uid || !this.source.war) {
      this.declareEl.hidden = true;
      return;
    }
    this.declareEl.hidden = false;
    this.declareEl.querySelector('.cm-declare-title')!.textContent = `${them.cityName}에 대해`;
    const al = this.source.alliances;
    const allyEl = this.declareEl.querySelector<HTMLElement>('.cm-ally')!;
    const warn = this.declareEl.querySelector<HTMLElement>('.cm-declare-warn')!;
    allyEl.hidden = !al;
    warn.textContent = '';
    this.renderPass(mine.uid, them);
    if (!al) return;
    const open = al.openWith(them.uid);
    const stateEl = allyEl.querySelector<HTMLElement>('.cm-ally-state')!;
    const go = allyEl.querySelector<HTMLButtonElement>('.cm-ally-go')!;
    allyEl.querySelector<HTMLSelectElement>('.cm-ally-deposit')!.hidden = !!open;
    if (!open) {
      stateEl.textContent = '동맹 아님 · 보증금은 양쪽이 같은 금액을 겁니다(배신하면 상대에게)';
      go.textContent = '동맹 신청';
    } else if (open.state === 'active') {
      stateEl.textContent = `🤝 동맹${open.deposit ? ` · 보증금 각 ${formatMoney(open.deposit)}` : ''}`;
      go.textContent = '동맹 해제(보증금 돌려받음)';
      warn.textContent = `⚠ 선전포고하면 배신입니다 — ${open.deposit ? `보증금 ${formatMoney(open.deposit)}이 상대에게 가고, ` : ''}${Math.round(BETRAYAL_LOCK_MS / 3_600_000)}시간 동안 새 동맹을 맺을 수 없습니다`;
    } else if (open.from === mine.uid) {
      stateEl.textContent = '동맹 신청을 보냈습니다 · 답을 기다리는 중';
      go.textContent = '신청 취소(보증금 돌려받음)';
    } else {
      stateEl.textContent = '이 도시가 동맹을 신청했습니다 · 위 알림에서 답하세요';
      go.textContent = '거절';
    }
  }

  /** 그 도시 영해·영공 규율과 내 통과 상태. */
  private renderPass(me: string, them: PublicCity): void {
    const passEl = this.declareEl.querySelector<HTMLElement>('.cm-pass')!;
    const ps = this.source.passes;
    passEl.hidden = !ps;
    if (!ps) return;
    const rule = them.pass ?? 'open';
    const p = ps.pass(me, them.uid);
    const ok = passValid(rule, p, Date.now());
    const st =
      rule === 'open'
        ? ''
        : ok
          ? ' · 통과 가능'
          : p?.state === 'asked'
            ? ' · 허가 기다리는 중'
            : p?.state === 'denied'
              ? ' · 거절됨'
              : '';
    passEl.querySelector('.cm-pass-state')!.textContent =
      `영해·영공: ${PASS_RULE_NAMES[rule]}${st}`;
    const go = passEl.querySelector<HTMLButtonElement>('.cm-pass-go')!;
    go.hidden = rule === 'open' || ok || p?.state === 'asked';
    go.textContent = rule === 'permit' ? '통과 허가 요청' : '통과 신고';
  }

  /** 다른 도시들의 대규모 전쟁: 동맹한 진영으로 참가. */
  renderOpenWars(): void {
    const war = this.source.war;
    const list = war?.openLarge ?? [];
    this.openWarsEl.hidden = !list.length;
    this.openWarsEl.innerHTML = '';
    const me = this.source.mine();
    for (const w of list) {
      const row = document.createElement('div');
      row.className = 'cm-open-war';
      const text = document.createElement('span');
      const count = (side: 'a' | 'b') =>
        1 + Object.values(w.joined ?? {}).filter((j) => j.side === side).length;
      text.textContent = `⚔ 대규모 전쟁: ${w.names[w.a] ?? '?'} 진영(${count('a')}) vs ${w.names[w.b] ?? '?'} 진영(${count('b')})`;
      row.append(text);
      for (const side of ['a', 'b'] as const) {
        const why = war!.joinWhy(w, side, me);
        row.append(
          button(
            `${w.names[w[side]] ?? '?'} 진영으로 참가`,
            async () => {
              const r = await war!.join(w, side, this.source.mine());
              this.source.announce(
                r || '전쟁에 참가했습니다 · 5분 준비 뒤 개전(이미 시작했으면 바로)',
              );
            },
            why,
          ),
        );
      }
      this.openWarsEl.append(row);
    }
  }

  /** 받은 요청: 통과 허가 요청, 동맹 신청(수락·거절). */
  renderIncoming(): void {
    const al = this.source.alliances;
    const list = al?.incoming() ?? [];
    const ps = this.source.passes;
    const me = this.source.mine().uid;
    const asks = (ps?.passes ?? []).filter((p) => p.to === me && p.state === 'asked');
    this.incomingEl.hidden = !list.length && !asks.length;
    this.incomingEl.innerHTML = '';
    for (const p of asks) {
      const name = this.cities().find((c) => c.uid === p.from)?.cityName ?? '다른 도시';
      this.incomingEl.append(
        row(
          `🛂 ${name} 통과 요청`,
          button('허가', () => void ps!.answer(p.from, true)),
          button('거절', () => void ps!.answer(p.from, false)),
        ),
      );
    }
    for (const a of list) {
      this.incomingEl.append(
        row(
          `🤝 ${a.names[a.from] ?? '다른 도시'}의 동맹 신청${a.deposit ? ` · 보증금 ${formatMoney(a.deposit)}` : ''}`,
          button('수락', async () => {
            const why = await al!.accept(a.id);
            this.source.announce(why || '동맹을 맺었습니다');
          }),
          button('거절', () => void al!.close(a.id)),
        ),
      );
    }
  }

  private async allyAction(): Promise<void> {
    const al = this.source.alliances;
    const them = this.target();
    if (!al || !them) return;
    const msg = this.declareEl.querySelector('.cm-declare-msg')!;
    const open = al.openWith(them.uid);
    if (open) {
      const why = await al.close(open.id);
      msg.textContent = why || (open.state === 'active' ? '동맹을 해제했습니다' : '처리했습니다');
      return;
    }
    const deposit = Number(
      this.declareEl.querySelector<HTMLSelectElement>('.cm-ally-deposit')!.value,
    );
    msg.textContent = '보내는 중…';
    const why = await al.request(them.uid, them.cityName, deposit);
    msg.textContent = why || '동맹을 신청했습니다';
  }

  private async declare(how: 'small' | 'surprise' | 'large'): Promise<void> {
    const war = this.source.war;
    const them = this.target();
    if (!war || !them) return;
    const msg = this.declareEl.querySelector('.cm-declare-msg')!;
    msg.textContent = '보내는 중…';
    const why = await war.declare(
      them,
      this.source.mine(),
      how === 'large' ? 'large' : 'small',
      how === 'surprise',
    );
    msg.textContent = why || '선전포고했습니다';
    this.onDeclared();
  }
}

/** 글 한 줄 + 버튼들(알림 줄). */
export function row(text: string, ...buttons: HTMLButtonElement[]): HTMLElement {
  const el = document.createElement('div');
  el.className = 'cm-incoming-row';
  const span = document.createElement('span');
  span.textContent = text;
  el.append(span, ...buttons);
  return el;
}

/** 버튼. why 가 있으면 누를 수 없고 이유를 title 로. */
export function button(text: string, onClick: () => void, why = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.disabled = !!why;
  b.title = why;
  b.addEventListener('click', onClick);
  return b;
}
