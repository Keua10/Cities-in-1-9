import {
  browserLocalPersistence,
  getRedirectResult,
  GoogleAuthProvider,
  signOut as fbSignOut,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signInWithRedirect,
  type User,
} from 'firebase/auth';
import { getFirebase } from './firebase';

/**
 * 인증 레이어 — 개인 구글 계정으로 로그인한다.
 *
 *   - 도시 문서 ID = 로그인 UID 라서 구글 계정 하나에 도시 하나.
 *   - 관리자는 이메일의 SHA-256 으로 알아본다(공개 저장소에 주소를 적지 않으려고).
 *     서버 쪽 판정은 firestore.rules 의 isAdmin() 이 같은 해시로 한다 — 화면의
 *     isAdmin 은 버튼을 보이고 숨기는 데만 쓰고, 실제 권한은 규칙이 막는다.
 */

/** 관리자 계정 이메일(소문자)의 SHA-256. firestore.rules 의 isAdmin() 과 같은 값. */
export const ADMIN_EMAIL_SHA256 =
  'dd324353f3c2d4b7b6c74c3dab4b5f2da09440e4629be626bafff53acd106886';

export interface Session {
  uid: string;
  /** 화면에 보일 이름(구글 이름, 없으면 이메일 앞부분). */
  loginId: string;
  email: string;
  /** 관리자 계정인가(화면용. 실제 권한은 규칙). */
  isAdmin: boolean;
}

export class AuthError extends Error {}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function isAdminEmail(email: string | null | undefined): Promise<boolean> {
  if (!email) return false;
  return (await sha256Hex(email.trim().toLowerCase())) === ADMIN_EMAIL_SHA256;
}

async function toSession(user: User): Promise<Session> {
  const email = user.email ?? '';
  return {
    uid: user.uid,
    loginId: user.displayName || email.split('@')[0] || '이름 없음',
    email,
    isAdmin: user.emailVerified && (await isAdminEmail(email)),
  };
}

/** 기기에 남은 로그인(있으면 Session). 리다이렉트 로그인에서 막 돌아온 경우도 받는다. */
export async function restoreSession(): Promise<Session | null> {
  const fb = getFirebase();
  if (!fb) return null;
  try {
    const back = await getRedirectResult(fb.auth);
    if (back?.user) return toSession(back.user);
  } catch (err) {
    console.warn('리다이렉트 로그인 결과 실패', err);
  }
  const user = await new Promise<User | null>((resolve) => {
    const stop = onAuthStateChanged(
      fb.auth,
      (u) => {
        stop();
        resolve(u);
      },
      (err) => {
        stop();
        console.error('세션 확인 실패', err);
        resolve(null);
      },
    );
  });
  return user ? toSession(user) : null;
}

/**
 * 구글 로그인. 팝업이 막히는 브라우저(일부 태블릿·인앱 브라우저)는 페이지를 옮겨
 * 로그인한 뒤 돌아온다(그때는 이 함수가 끝나지 않고 페이지가 바뀐다).
 */
export async function signInWithGoogle(): Promise<Session> {
  const fb = getFirebase();
  if (!fb) throw new AuthError('서버 설정이 없어 로그인할 수 없습니다.');
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await setPersistence(fb.auth, browserLocalPersistence);
    const cred = await signInWithPopup(fb.auth, provider);
    return toSession(cred.user);
  } catch (err) {
    const code = errorCode(err);
    if (
      code === 'auth/popup-blocked' ||
      code === 'auth/operation-not-supported-in-this-environment' ||
      code === 'auth/web-storage-unsupported'
    ) {
      await signInWithRedirect(fb.auth, provider);
      return new Promise<Session>(() => {}); // 페이지가 넘어간다
    }
    throw new AuthError(describeAuthError(err));
  }
}

export async function signOut(): Promise<void> {
  const fb = getFirebase();
  if (!fb) return;
  await fbSignOut(fb.auth);
}

function errorCode(err: unknown): string {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : '';
}

/** Firebase 오류 코드를 읽을 수 있는 말로 바꾼다. */
function describeAuthError(err: unknown): string {
  switch (errorCode(err)) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return '로그인 창이 닫혔습니다. 다시 눌러 주세요.';
    case 'auth/unauthorized-domain':
      return '이 주소는 아직 로그인이 허용되지 않았습니다(Firebase 콘솔 → 승인된 도메인).';
    case 'auth/operation-not-allowed':
      return 'Firebase 콘솔에서 Google 로그인을 켜야 합니다.';
    case 'auth/too-many-requests':
      return '너무 여러 번 시도했습니다. 잠시 뒤에 다시 해 주세요.';
    case 'auth/network-request-failed':
      return '인터넷 연결을 확인해 주세요.';
    case 'auth/user-disabled':
      return '사용이 막힌 계정입니다. 선생님께 말해 주세요.';
    default:
      console.error('로그인 실패', err);
      return '로그인에 실패했습니다. 다시 해 보고, 안 되면 선생님께 말해 주세요.';
  }
}
