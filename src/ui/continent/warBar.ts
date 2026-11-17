import { parseChunkKey } from '../../core/iso';
import type { WarSession } from '../../net/warSession';
import { isNight, weatherAt, WEATHER_NAMES } from '../../sim/military/weather';

/**
 * 대륙 지도 위쪽 전쟁 줄: 상대·단계·남은 시간·점수·밤낮·날씨, 항복·휴전 버튼.
 * 두 나라와 동시에 싸우면 전선 버튼으로 보는 전쟁을 고른다.
 */
export class WarBar {
  /** 두 전선이면 지금 보는 전쟁. */
  focus: string | null = null;

  constructor(
    private el: HTMLElement,
    private war: () => WarSession | null,
    /** 내 수도 청크(밤낮·날씨 한 줄). */
    private capital: () => string,
    private announce: (text: string) => void,
  ) {
    const id = () => this.focus ?? undefined;
    this.q('.cm-war-surrender').addEventListener('click', () => {
      const w = this.war();
      if (!w) return;
      if (w.status(id()).surrenderPending) void w.withdrawSurrender(id());
      else void w.offerSurrender(id());
    });
    this.q('.cm-war-accept').addEventListener('click', () => {
      void this.war()?.acceptSurrender(id());
    });
    this.q('.cm-war-truce').addEventListener('click', async () => {
      const w = this.war();
      if (!w) return;
      if (w.status(id()).ceasefire?.byMe) await w.withdrawCeasefire(id());
      else {
        const why = await w.offerCeasefire(id());
        this.announce(
          why || '휴전을 제안했습니다 · 참가국 2/3(직접 참여국 둘 다 포함)가 찬성하면 휴전',
        );
      }
    });
    this.q('.cm-war-truce-yes').addEventListener('click', () => {
      void this.war()?.voteCeasefire(true, id());
    });
    this.q('.cm-war-truce-no').addEventListener('click', () => {
      void this.war()?.voteCeasefire(false, id());
    });
  }

  private q<T extends HTMLElement = HTMLButtonElement>(sel: string): T {
    return this.el.querySelector<T>(sel)!;
  }

  render(): void {
    const war = this.war();
    const fronts = war?.currentWars() ?? [];
    if (!fronts.some((w) => w.id === this.focus)) this.focus = fronts[0]?.id ?? null;
    const st = war?.status(this.focus ?? undefined);
    if (!war || !st || st.phase === 'none' || st.phase === 'ended') {
      this.el.hidden = true;
      return;
    }
    this.el.hidden = false;
    this.renderFronts(war, fronts);
    const phase =
      st.phase === 'prep'
        ? `준비 ${mmss(st.prepLeftMs)} — 부대를 국경에 배치하세요`
        : st.phase === 'paused'
          ? '일시정지 — 상대가 접속을 끊었습니다(24시간 뒤 판정)'
          : '전투 중';
    this.q<HTMLElement>('.cm-war-text').textContent =
      `⚔ ${st.enemyName}와 ${st.war?.kind === 'large' ? '대규모' : '소규모'} 전쟁 · ${phase} · 점수 ${st.scoreMe.toLocaleString('ko-KR')} : ${st.scoreEnemy.toLocaleString('ko-KR')}` +
      (st.allies.length ? ` · 우리 진영: ${st.allies.join(', ')}` : '') +
      ` · ${this.skyText()}`;
    // 항복 신청·철회는 진영 대표만.
    const surrender = this.q('.cm-war-surrender');
    surrender.hidden = !st.isLeader;
    surrender.textContent = st.surrenderPending ? '항복 철회' : '항복 신청';
    const accept = this.q('.cm-war-accept');
    accept.hidden = !st.surrenderOffered;
    accept.textContent = st.allies.length ? '항복에 동의(대표 동의 또는 2/3)' : '항복 받아들이기';
    // 휴전: 참가국 누구나 제안, 모든 진영 2/3 + 직접 참여국 둘 다 찬성이면 휴전.
    const c = st.ceasefire;
    const truce = this.q('.cm-war-truce');
    truce.hidden = st.phase === 'prep' || (!!c && !c.byMe);
    truce.textContent = c?.byMe ? `휴전 제안 철회 (찬성 ${c.yes}/${c.needed})` : '휴전 제안';
    const voting = !!c && !c.byMe;
    const yes = this.q('.cm-war-truce-yes');
    const no = this.q('.cm-war-truce-no');
    yes.hidden = no.hidden = !voting;
    if (c && voting) {
      yes.textContent = `${c.byName}의 휴전 제안 찬성 (${c.yes}/${c.needed}${c.myVote === true ? ' ✓' : ''})`;
      no.textContent = c.myVote === false ? '반대함' : '반대';
      yes.disabled = c.myVote === true;
      no.disabled = c.myVote === false;
    }
  }

  /** 전선이 둘 이상이면 상대 이름 버튼. */
  private renderFronts(war: WarSession, fronts: ReturnType<WarSession['currentWars']>): void {
    const el = this.q<HTMLElement>('.cm-war-fronts');
    const sig = fronts.map((w) => w.id).join('|') + '#' + this.focus;
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.innerHTML = '';
    if (fronts.length < 2) return;
    for (const w of fronts) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = war.status(w.id).enemyName;
      b.classList.toggle('on', w.id === this.focus);
      b.addEventListener('click', () => {
        this.focus = w.id;
        this.render();
      });
      el.append(b);
    }
  }

  /** 내 수도 위 밤낮·날씨 한 줄(효과 포함). */
  private skyText(): string {
    const now = Date.now();
    const { cx, cy } = parseChunkKey(this.capital());
    const w = weatherAt(now, cx, cy);
    const effect =
      w === 'rain' || w === 'snow' ? '(땅 부대 이동 −20%)' : w === 'wind' ? '(공군 공격 −30%)' : '';
    return `${isNight(now) ? '🌙 밤(시야 절반)' : '☀ 낮'} · ${WEATHER_NAMES[w]}${effect}`;
  }
}

function mmss(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
