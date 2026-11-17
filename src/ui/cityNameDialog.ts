/**
 * 새 도시 이름 정하기(시작 자리를 고른 뒤 한 번). 대륙 지도·전쟁 알림에 보이는 이름이다.
 * 2~12자, 앞뒤 공백 없음. 비워 두면 기본 이름.
 */
export function askCityName(fallback: string): Promise<string> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = 'login';
    overlay.innerHTML = `
      <form class="login-card">
        <h1>도시 이름</h1>
        <p class="login-sub">대륙 지도와 외교·전쟁 알림에 이 이름이 보입니다. 나중에 바꿀 수 없어요.</p>
        <input class="city-name-input" maxlength="12" autocomplete="off" spellcheck="false" />
        <p class="login-error" role="alert"></p>
        <div class="login-actions"><button class="login-btn primary">이 이름으로 시작</button></div>
      </form>`;
    const form = overlay.querySelector('form')!;
    const input = overlay.querySelector<HTMLInputElement>('input')!;
    const error = overlay.querySelector<HTMLElement>('.login-error')!;
    input.placeholder = fallback;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = input.value.trim().replace(/\s+/g, ' ');
      if (name && (name.length < 2 || name.length > 12)) {
        error.textContent = '2~12자로 지어 주세요.';
        return;
      }
      if (/[<>]/.test(name)) {
        error.textContent = '< > 는 쓸 수 없습니다.';
        return;
      }
      overlay.classList.add('leaving');
      window.setTimeout(() => overlay.remove(), 350);
      resolve(name || fallback);
    });
    document.body.append(overlay);
    input.focus();
  });
}
