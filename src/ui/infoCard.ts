/**
 * 정보 카드: 글을 이어 붙이지 않고 이름·상태·막대·문제 칩·서비스 칸으로 보여 준다.
 * 설명이 필요한 것은 ⓘ 를 눌러야 열리는 짧은 팝업으로 뺀다.
 */

export type Tone = 'ok' | 'warn' | 'bad';

export interface InfoCard {
  title: string;
  /** 이름 옆 작은 글씨(종류·등급). */
  sub?: string;
  /** 한눈에 보는 상태(가동 중 / 멈춤: 이유 / 공실). */
  status?: { text: string; tone: Tone };
  /** 0~1 막대. */
  meters?: Array<{ label: string; value: number }>;
  /** 짧은 사실 몇 줄(숫자 위주). */
  facts?: string[];
  /** 고칠 것만(빨간 칩). */
  problems?: string[];
  /** 서비스 칸: 0~1, 없음·과부하 표시. */
  services?: Array<{ label: string; value: number; none?: boolean; over?: boolean }>;
  /** 맨 아래 작은 글씨(유지비 등). */
  foot?: string;
  /** ⓘ 팝업 글(짧게). */
  help?: string;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function toneOf(v: number): Tone {
  return v >= 0.75 ? 'ok' : v >= 0.4 ? 'warn' : 'bad';
}

/** 카드 HTML. helpOpen 이면 ⓘ 팝업을 펼친 채로. */
export function renderCard(card: InfoCard, helpOpen = false): string {
  const e = escapeHtml;
  let h = `<div class="ic"><div class="ic-head"><b>${e(card.title)}</b>`;
  if (card.sub) h += `<small>${e(card.sub)}</small>`;
  if (card.help)
    h += `<button type="button" class="i-btn" aria-label="설명" aria-expanded="${helpOpen}">i</button>`;
  h += '</div>';
  if (card.help) h += `<div class="i-pop"${helpOpen ? '' : ' hidden'}>${e(card.help)}</div>`;
  if (card.status)
    h += `<span class="ic-status t-${card.status.tone}">${e(card.status.text)}</span>`;
  if (card.meters?.length) {
    h += '<div class="ic-meters">';
    for (const m of card.meters) {
      const v = Math.max(0, Math.min(1, m.value));
      h += `<div class="ic-m"><span>${e(m.label)}</span><i class="t-${toneOf(v)}" style="--v:${Math.round(v * 100)}%"></i><em>${Math.round(v * 100)}%</em></div>`;
    }
    h += '</div>';
  }
  if (card.facts?.length)
    h += `<ul class="ic-facts">${card.facts.map((f) => `<li>${e(f)}</li>`).join('')}</ul>`;
  if (card.problems?.length)
    h += `<div class="ic-chips">${card.problems.map((p) => `<span class="chip t-bad">${e(p)}</span>`).join('')}</div>`;
  if (card.services?.length) {
    h += '<div class="ic-svc">';
    for (const s of card.services) {
      const tone = s.none ? 'bad' : s.over ? 'warn' : toneOf(s.value);
      const dots = s.none
        ? '없음'
        : '●'.repeat(Math.round(s.value * 4)) + '○'.repeat(4 - Math.round(s.value * 4));
      h += `<span class="svc t-${tone}"><b>${e(s.label)}</b><i>${dots}${s.over ? ' !' : ''}</i></span>`;
    }
    h += '</div>';
  }
  if (card.foot) h += `<div class="ic-foot">${e(card.foot)}</div>`;
  return h + '</div>';
}

/**
 * 고정된 화면 요소 옆에 ⓘ 버튼 + 팝업을 붙인다(대륙 지도 범례 등).
 * 바깥을 누르면 닫힌다.
 */
export function attachInfo(host: HTMLElement, text: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'i-btn';
  btn.textContent = 'i';
  btn.setAttribute('aria-label', '설명');
  btn.setAttribute('aria-expanded', 'false');
  const pop = document.createElement('div');
  pop.className = 'i-pop';
  pop.hidden = true;
  pop.textContent = text;
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    pop.hidden = !pop.hidden;
    btn.setAttribute('aria-expanded', String(!pop.hidden));
  });
  document.addEventListener('click', (ev) => {
    if (!pop.hidden && !pop.contains(ev.target as Node)) {
      pop.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
  });
  host.append(btn, pop);
  return btn;
}
