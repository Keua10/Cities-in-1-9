import {
  allowSignup,
  AuthError,
  createAccount,
  restoreSession,
  signIn,
  type Session,
} from '../net/auth';
import { firebaseConfigured } from '../net/firebase';

/**
 * 로그인 화면.
 *
 * 가입 버튼은 기본적으로 없다. 계정은 선생님이 콘솔에서 만든 것만 존재한다
 * (도시가 망했다고 계정을 새로 파는 걸 막기 위해서다).
 * 개발 중에 계정을 몰아서 만들 때만 VITE_ALLOW_SIGNUP=1 로 켠다.
 *
 * 돌려주는 값:
 *   Session  로그인 성공
 *   null     서버 없이 둘러보기 (저장 안 됨)
 */
export async function requireSession(): Promise<Session | null> {
  if (!firebaseConfigured) {
    return showScreen({ offlineOnly: true });
  }

  const existing = await restoreSession();
  if (existing) return existing;

  return showScreen({ offlineOnly: false });
}

interface ScreenOptions {
  offlineOnly: boolean;
}

function showScreen(options: ScreenOptions): Promise<Session | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = 'login';

    const card = document.createElement('div');
    card.className = 'login-card';
    overlay.appendChild(card);

    const title = document.createElement('h1');
    title.textContent = '1-9 도시';
    card.appendChild(title);

    const message = document.createElement('p');
    message.className = 'login-msg';
    card.appendChild(message);

    const finish = (session: Session | null): void => {
      overlay.remove();
      resolve(session);
    };

    if (options.offlineOnly) {
      message.textContent =
        '서버 설정이 없어 저장 없이 둘러보기만 할 수 있습니다.';
      const browse = button('둘러보기', 'primary', () => finish(null));
      card.appendChild(browse);
      document.body.appendChild(overlay);
      return;
    }

    message.textContent = '선생님께 받은 번호와 비밀번호를 입력하세요.';

    const idInput = field(card, '번호', 'text');
    idInput.inputMode = 'numeric';
    idInput.autocomplete = 'username';

    const pwInput = field(card, '비밀번호', 'password');
    pwInput.autocomplete = 'current-password';

    const error = document.createElement('p');
    error.className = 'login-error';
    card.appendChild(error);

    const actions = document.createElement('div');
    actions.className = 'login-actions';
    card.appendChild(actions);

    let busy = false;

    const run = async (fn: () => Promise<Session>): Promise<void> => {
      if (busy) return;
      busy = true;
      error.textContent = '';
      submit.disabled = true;
      submit.textContent = '들어가는 중…';
      try {
        finish(await fn());
      } catch (err) {
        error.textContent =
          err instanceof AuthError ? err.message : '로그인에 실패했습니다.';
        if (!(err instanceof AuthError)) console.error(err);
        offerOffline();
        busy = false;
        submit.disabled = false;
        submit.textContent = '들어가기';
      }
    };

    const submit = button('들어가기', 'primary', () => {
      void run(() => signIn(idInput.value, pwInput.value));
    });
    actions.appendChild(submit);

    if (allowSignup) {
      const make = button('계정 만들기(개발용)', 'ghost', () => {
        void run(() => createAccount(idInput.value, pwInput.value));
      });
      actions.appendChild(make);
    }

    let offlineShown = false;
    const offerOffline = (): void => {
      if (offlineShown) return;
      offlineShown = true;
      const skip = button('저장 없이 둘러보기', 'ghost', () => finish(null));
      actions.appendChild(skip);
    };

    for (const input of [idInput, pwInput]) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit.click();
      });
    }

    document.body.appendChild(overlay);
    idInput.focus();
  });
}

function field(
  parent: HTMLElement,
  label: string,
  type: string,
): HTMLInputElement {
  const wrap = document.createElement('label');
  wrap.className = 'login-field';
  const text = document.createElement('span');
  text.textContent = label;
  const input = document.createElement('input');
  input.type = type;
  input.autocapitalize = 'off';
  input.spellcheck = false;
  wrap.append(text, input);
  parent.appendChild(wrap);
  return input;
}

function button(
  label: string,
  variant: 'primary' | 'ghost',
  onClick: () => void,
): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `login-btn ${variant}`;
  el.textContent = label;
  el.addEventListener('click', onClick);
  return el;
}
