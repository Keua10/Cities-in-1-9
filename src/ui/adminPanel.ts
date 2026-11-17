import { bindNatureControls } from './natureControls';
import type { NatureSystem } from '../sim/nature';
import './adminPanel.css';
import { formatMoney, parseAdminMoney, toWon } from './money';
import { activeWars, forceTruce, loadSettings, orderCity, saveSettings } from '../net/admin';
import { loadPublicCities } from '../net/publicCities';

/**
 * 도시를 다시 만드는 방식.
 *
 * 'empty' 가 학생이 실제로 받는 상태다. 대도시는 수업 시연·밸런스 확인용이라
 * 이 패널을 통해서만 만들어진다.
 */
export type CityResetMode = 'metropolis' | 'empty';

/**
 * 관리자 도구. **관리자 구글 계정**에만 버튼이 보인다(서버 권한은 firestore.rules 가 막는다).
 * 서버 설정이 없는 개발 컴퓨터에서는 내 도시 도구만 쓸 수 있다.
 */
export function bindAdminPanel(deps: {
  nature: NatureSystem;
  mapCenter: () => { tx: number; ty: number };
  getMoney: () => number;
  setMoney: (amount: number) => Promise<void>;
  resetCity: (mode: CityResetMode) => Promise<void>;
  loggedIn: boolean;
  isAdmin: boolean;
}): void {
  const btn = document.getElementById('btn-admin')!;
  const allowed = deps.isAdmin || !deps.loggedIn;
  btn.hidden = !allowed;
  btn.textContent = '관리자 도구';
  if (!allowed) return;
  const server = deps.isAdmin && deps.loggedIn;

  const dialog = document.createElement('dialog');
  dialog.id = 'admin-panel';
  dialog.setAttribute('aria-labelledby', 'admin-title');
  dialog.innerHTML = `<header><b id="admin-title">관리자 도구</b><button type="button" id="admin-close" aria-label="관리자 도구 닫기">×</button></header>
    <p id="admin-result" role="status"></p>
    <fieldset id="admin-game"><legend>게임 전체</legend>
      <label class="admin-check"><input type="checkbox" id="admin-wars"> 선전포고 허용 <small>(끄면 새 전쟁 금지, 진행 중 전쟁은 그대로)</small></label>
      <form id="admin-notice"><label>공지(접속할 때 모두에게 보임, 비우면 없음)<input name="notice" maxlength="120"></label><button>공지 저장</button></form>
    </fieldset>
    <fieldset id="admin-wars-box"><legend>진행 중인 전쟁</legend><div id="admin-war-list"><small>불러오는 중…</small></div></fieldset>
    <fieldset id="admin-cities-box"><legend>도시</legend>
      <small>지시는 그 학생이 다음에 접속할 때 실행됩니다.</small>
      <div id="admin-city-list"><small>불러오는 중…</small></div>
    </fieldset>
    <fieldset id="admin-mine"><legend>내 도시</legend>
      <form id="admin-money"><label>도시 자금 설정 (원)<input name="amount" type="text" inputmode="numeric" required></label><small>0 ~ 1,000,000,000,000원 · 정수 입력</small><button>자금 적용</button></form>
      <button type="button" id="admin-generate">대도시 생성</button>
      <button type="button" id="admin-clear">빈 도시로 초기화</button>
      <p>둘 다 현재 도시를 지우고 새로 만듭니다. 되돌릴 수 없습니다.</p>
    </fieldset>`;
  document.body.append(dialog);
  const mine = dialog.querySelector<HTMLElement>('#admin-mine')!;
  const funds = dialog.querySelector<HTMLFormElement>('#admin-money')!;
  const amount = funds.elements.namedItem('amount') as HTMLInputElement;
  const result = dialog.querySelector<HTMLElement>('#admin-result')!;
  const warsBox = dialog.querySelector<HTMLInputElement>('#admin-wars')!;
  const noticeForm = dialog.querySelector<HTMLFormElement>('#admin-notice')!;
  const noticeInput = noticeForm.elements.namedItem('notice') as HTMLInputElement;
  const warList = dialog.querySelector<HTMLElement>('#admin-war-list')!;
  const cityList = dialog.querySelector<HTMLElement>('#admin-city-list')!;
  for (const id of ['#admin-game', '#admin-wars-box', '#admin-cities-box'])
    dialog.querySelector<HTMLElement>(id)!.hidden = !server;
  bindNatureControls(mine, deps.nature, deps.mapCenter);
  let busy = false;

  const run = async (action: () => Promise<void>, success: string): Promise<void> => {
    if (busy) return;
    busy = true;
    dialog.querySelectorAll('button').forEach((b) => (b.disabled = true));
    result.textContent = '처리 중…';
    try {
      await action();
      result.textContent = success;
    } catch (err) {
      result.textContent = `처리 실패: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      busy = false;
      dialog.querySelectorAll('button').forEach((b) => (b.disabled = false));
    }
  };

  const refreshServer = async (): Promise<void> => {
    if (!server) return;
    const [settings, wars, cities] = await Promise.all([
      loadSettings(),
      activeWars().catch(() => []),
      loadPublicCities().catch(() => []),
    ]);
    warsBox.checked = settings.warsEnabled;
    noticeInput.value = settings.notice;
    warList.innerHTML = '';
    if (!wars.length) warList.innerHTML = '<small>없음</small>';
    for (const w of wars) {
      const row = document.createElement('div');
      row.className = 'admin-row';
      const side = (s: 'a' | 'b') =>
        [
          w[s],
          ...Object.entries(w.joined ?? {})
            .filter(([, j]) => j.side === s)
            .map(([u]) => u),
        ]
          .map((u) => w.names[u] ?? u.slice(0, 6))
          .join('·');
      row.innerHTML = `<span>${w.kind === 'large' ? '대규모' : '소규모'} · ${esc(side('a'))} vs ${esc(side('b'))} · ${w.state === 'prep' ? '준비' : w.pausedAt ? '일시정지' : '전투'}</span>`;
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.textContent = '강제 휴전';
      stop.addEventListener('click', () => {
        if (!window.confirm('이 전쟁을 배상 없는 휴전으로 끝냅니다(12시간 전쟁 금지).')) return;
        void run(async () => {
          await forceTruce(w.id);
          await refreshServer();
        }, '전쟁을 멈췄습니다.');
      });
      row.append(stop);
      warList.append(row);
    }
    cityList.innerHTML = '';
    if (!cities.length) cityList.innerHTML = '<small>없음</small>';
    for (const c of cities.sort((a, b) => a.cityIndex - b.cityIndex)) {
      const row = document.createElement('div');
      row.className = 'admin-row';
      row.innerHTML = `<span>${c.online ? '🟢' : '⚪'} ${esc(c.cityName)} · Lv.${c.cityLevel} · ${c.population.toLocaleString('ko-KR')}명</span>`;
      const give = document.createElement('button');
      give.type = 'button';
      give.textContent = '자금 지급';
      give.addEventListener('click', () => {
        const won = parseAdminMoney(window.prompt(`${c.cityName}에 줄 돈(원)`, '10000000') ?? '');
        if (won === null || won <= 0) return;
        void run(
          () => orderCity(c.uid, { kind: 'grant', amount: won }),
          `${c.cityName}: 다음 접속 때 ${formatMoney(won)} 지급`,
        );
      });
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.textContent = '초기화';
      reset.addEventListener('click', () => {
        if (
          !window.confirm(
            `${c.cityName}을(를) 다음 접속 때 빈 도시로 초기화합니다. 되돌릴 수 없습니다.`,
          )
        )
          return;
        void run(() => orderCity(c.uid, { kind: 'reset' }), `${c.cityName}: 다음 접속 때 초기화`);
      });
      row.append(give, reset);
      cityList.append(row);
    }
  };

  btn.addEventListener('click', () => {
    document.dispatchEvent(new Event('close-game-panels'));
    document.dispatchEvent(new Event('close-build-palette'));
    amount.value = String(toWon(deps.getMoney()));
    result.textContent = deps.loggedIn
      ? ''
      : '둘러보기 모드: 새로고침하면 바뀐 것이 유지되지 않습니다.';
    dialog.showModal();
    void refreshServer();
  });
  dialog.querySelector('#admin-close')!.addEventListener('click', () => dialog.close());
  warsBox.addEventListener('change', () => {
    void run(
      () => saveSettings({ warsEnabled: warsBox.checked }),
      warsBox.checked ? '선전포고를 다시 허용했습니다.' : '새 선전포고를 막았습니다.',
    );
  });
  noticeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    void run(
      () => saveSettings({ notice: noticeInput.value.trim(), noticeAt: Date.now() }),
      '공지를 저장했습니다.',
    );
  });
  funds.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = parseAdminMoney(amount.value);
    if (value === null) {
      result.textContent = '허용 범위 안의 0 이상 정수를 입력하세요.';
      return;
    }
    void run(() => deps.setMoney(value), `도시 자금을 ${formatMoney(value)}으로 설정했습니다.`);
  });
  const bindReset = (id: string, mode: CityResetMode, confirmText: string, success: string) => {
    dialog.querySelector(`#${id}`)!.addEventListener('click', () => {
      if (busy || !window.confirm(confirmText)) return;
      void run(() => deps.resetCity(mode), success);
    });
  };
  bindReset(
    'admin-generate',
    'metropolis',
    '현재 도시를 지우고 새 대도시를 생성합니다. 되돌릴 수 없습니다. 계속할까요?',
    '대도시를 생성했습니다.',
  );
  bindReset(
    'admin-clear',
    'empty',
    '현재 도시를 지우고 빈 땅에서 다시 시작합니다. 되돌릴 수 없습니다. 계속할까요?',
    '빈 도시로 초기화했습니다.',
  );
}

function esc(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );
}
