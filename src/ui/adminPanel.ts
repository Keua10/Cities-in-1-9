import './adminPanel.css';
import { formatMoney, parseAdminMoney, toWon } from './money';

/**
 * 도시를 다시 만드는 방식.
 *
 * 'empty' 가 학생이 실제로 받는 상태다. 대도시는 수업 시연·밸런스 확인용이라
 * 이 패널을 통해서만 만들어진다.
 */
export type CityResetMode = 'metropolis' | 'empty';

/** Local game tools; this code gate is not server-side administrator authentication. */
export function bindAdminPanel(deps: {
  getMoney: () => number;
  setMoney: (amount: number) => Promise<void>;
  resetCity: (mode: CityResetMode) => Promise<void>;
  loggedIn: boolean;
}): void {
  const dialog = document.createElement('dialog');
  dialog.id = 'admin-panel';
  dialog.setAttribute('aria-labelledby', 'admin-title');
  dialog.innerHTML = `<header><b id="admin-title">관리자 도구</b><button type="button" id="admin-close" aria-label="관리자 도구 닫기">×</button></header>
    <form id="admin-unlock"><label>관리자 코드<input name="code" type="password" autocomplete="off" required></label><button>열기</button></form>
    <div id="admin-controls" hidden><form id="admin-money"><label>도시 자금 설정 (원)<input name="amount" type="text" inputmode="numeric" required></label><small>0 ~ 1,000,000,000,000원 · 정수 입력</small><button>자금 적용</button></form>
    <button type="button" id="admin-generate">대도시 생성</button>
    <button type="button" id="admin-clear">빈 도시로 초기화</button>
    <p>둘 다 현재 도시를 지우고 새로 만듭니다. 되돌릴 수 없습니다.<br>
    대도시 생성은 다 자란 도시를 심고, 빈 도시로 초기화는 학생이 처음 받는 상태(빈 땅 + 시작 자금)로 되돌립니다.</p></div><p id="admin-result" role="status"></p>`;
  document.body.append(dialog);
  const unlock = dialog.querySelector<HTMLFormElement>('#admin-unlock')!;
  const controls = dialog.querySelector<HTMLElement>('#admin-controls')!;
  const funds = dialog.querySelector<HTMLFormElement>('#admin-money')!;
  const amount = funds.elements.namedItem('amount') as HTMLInputElement;
  const result = dialog.querySelector<HTMLElement>('#admin-result')!;
  let unlocked = false;
  let busy = false;
  document.getElementById('btn-admin')!.addEventListener('click', () => {
    document.dispatchEvent(new Event('close-game-panels'));
    document.dispatchEvent(new Event('close-build-palette'));
    amount.value = String(toWon(deps.getMoney()));
    dialog.showModal();
  });
  dialog.querySelector('#admin-close')!.addEventListener('click', () => dialog.close());
  unlock.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = unlock.elements.namedItem('code') as HTMLInputElement;
    if (code.value !== 'omelet9900') {
      result.textContent = '코드가 올바르지 않습니다.';
      return;
    }
    code.value = '';
    unlocked = true;
    unlock.hidden = true;
    controls.hidden = false;
    result.textContent = deps.loggedIn
      ? '관리자 도구가 열렸습니다.'
      : '둘러보기 모드: 새로고침하면 자금 설정이 유지되지 않습니다.';
    amount.focus();
  });
  const run = async (action: () => Promise<void>, success: string) => {
    if (!unlocked || busy) return;
    busy = true;
    controls.querySelectorAll('button').forEach((b) => {
      b.disabled = true;
    });
    result.textContent = '처리 중…';
    try {
      await action();
      result.textContent = success;
    } catch (err) {
      result.textContent = `처리 실패: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      busy = false;
      controls.querySelectorAll('button').forEach((b) => {
        b.disabled = false;
      });
    }
  };
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
      if (!unlocked || busy || !window.confirm(confirmText)) return;
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
