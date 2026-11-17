import {
  AuthError,
  justRedirected,
  restoreSession,
  signInWithGoogle,
  signOut,
  type Session,
} from '../net/auth';
import { firebaseConfigured } from '../net/firebase';

/**
 * 첫 화면 = 로그인 화면. 개인 구글 계정으로 들어간다.
 *
 * 이미 이 기기에서 로그인했으면 "○○(으)로 계속"과 "다른 계정" 을 보여 준다.
 * 서버 설정이 없을 때(개발 컴퓨터)만 저장 없는 둘러보기가 있다.
 *
 * 돌려주는 값: Session(로그인) 또는 null(둘러보기 — 서버 설정이 없을 때만).
 */
export async function requireSession(): Promise<Session | null> {
  if (!firebaseConfigured) return showScreen(null, true);
  const existing = await restoreSession();
  // 팝업이 막혀 구글 페이지로 다녀온 경우: 방금 고른 계정으로 바로 들어간다.
  if (existing && justRedirected) return existing;
  return showScreen(existing, false);
}

function showScreen(existing: Session | null, offlineOnly: boolean): Promise<Session | null> {
  return new Promise((resolve) => {
    document.getElementById('loading')?.classList.add('behind-login');
    const overlay = document.createElement('div');
    overlay.id = 'login';
    overlay.innerHTML = `
      <div class="login-sky" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="login-card">
        <div class="login-logo" aria-hidden="true">
          <span class="b1"></span><span class="b2"></span><span class="b3"></span><span class="b4"></span>
        </div>
        <h1>1-9 도시</h1>
        <p class="login-sub">도시를 세우고, 땅을 넓히고, 이웃과 겨루는 우리 반 도시 만들기</p>
        <p class="login-msg"></p>
        <div class="login-actions"></div>
        <p class="login-error" role="alert"></p>
        <p class="login-foot"></p>
      </div>`;
    const msg = overlay.querySelector<HTMLElement>('.login-msg')!;
    const actions = overlay.querySelector<HTMLElement>('.login-actions')!;
    const error = overlay.querySelector<HTMLElement>('.login-error')!;
    const foot = overlay.querySelector<HTMLElement>('.login-foot')!;

    const finish = (session: Session | null): void => {
      overlay.classList.add('leaving');
      window.setTimeout(() => overlay.remove(), 350);
      document.getElementById('loading')?.classList.remove('behind-login');
      resolve(session);
    };

    if (offlineOnly) {
      msg.textContent = '서버 설정이 없어 저장 없이 둘러보기만 할 수 있습니다.';
      actions.append(button('둘러보기', 'primary', () => finish(null)));
      document.body.append(overlay);
      return;
    }

    let busy = false;
    const google = button('', 'google', async () => {
      if (busy) return;
      busy = true;
      error.textContent = '';
      google.disabled = true;
      google.querySelector('span')!.textContent = '구글 창에서 계정을 고르세요…';
      try {
        finish(await signInWithGoogle());
      } catch (err) {
        error.textContent = err instanceof AuthError ? err.message : '로그인에 실패했습니다.';
        busy = false;
        google.disabled = false;
        google.querySelector('span')!.textContent = 'Google 계정으로 시작하기';
      }
    });
    google.innerHTML = `${GOOGLE_G}<span>Google 계정으로 시작하기</span>`;

    if (existing) {
      msg.textContent = `${existing.loginId} 님, 다시 오셨네요.`;
      const go = button(`${existing.loginId}(으)로 계속하기`, 'primary', () => finish(existing));
      const other = button('다른 계정으로 로그인', 'ghost', async () => {
        await signOut();
        msg.textContent = '개인 구글 계정으로 로그인하세요.';
        go.remove();
        other.remove();
        actions.prepend(google);
      });
      actions.append(go, other);
      foot.textContent = existing.email;
    } else {
      msg.textContent = '개인 구글 계정으로 로그인하세요. 계정 하나에 도시 하나입니다.';
      actions.append(google);
      foot.textContent = '처음이면 대륙 지도에서 도시를 세울 자리를 고르게 됩니다.';
    }
    document.body.append(overlay);
  });
}

const GOOGLE_G = `<svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.8 6C12.3 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.4 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.2.8-4.7l-7.8-6C1 16.5 0 20.1 0 24s1 7.5 2.6 10.7l7.8-6z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.2-8.5 2.2-6.3 0-11.7-4.1-13.6-9.8l-7.8 6C6.6 42.6 14.6 48 24 48z"/></svg>`;

function button(
  label: string,
  variant: 'primary' | 'ghost' | 'google',
  onClick: () => void,
): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `login-btn ${variant}`;
  el.textContent = label;
  el.addEventListener('click', onClick);
  return el;
}
