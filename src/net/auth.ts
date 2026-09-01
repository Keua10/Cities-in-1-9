import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  type User,
} from 'firebase/auth';
import { getFirebase } from './firebase';

/**
 * 인증 레이어.
 *
 * 지금 방식: **교사가 미리 만들어 둔 계정으로만 로그인**한다.
 *   - 앱에는 가입 기능이 없다. 계정은 Firebase 콘솔에서 만든 것만 존재한다.
 *     → 도시가 망했다고 계정을 새로 파서 다시 시작하는 게 불가능하다.
 *   - 도시 문서 ID = 로그인 UID 라서 한 계정에 도시 하나가 구조적으로 강제된다.
 *
 * 학생은 "번호 + 비밀번호" 만 친다. 번호는 내부에서 이메일로 바뀐다.
 *   7  ->  s07@<VITE_STUDENT_DOMAIN>
 * 교사 계정처럼 숫자가 아닌 아이디도 그대로 쓸 수 있다.
 *   teacher -> teacher@<VITE_STUDENT_DOMAIN>
 *
 * 나중에 학급 사이트의 자체 로그인과 붙일 때는 이 파일만 갈아끼우면 된다.
 * (Vercel 함수에서 Firebase 커스텀 토큰을 발급 -> signInWithCustomToken)
 * 바깥에서는 Session 만 보므로 다른 코드는 손댈 필요가 없다.
 */

export interface Session {
  uid: string;
  /** 학생이 입력한 아이디(번호). 표시용. */
  loginId: string;
}

/** 개발 중 계정을 빠르게 만들 때만 켠다. 배포 환경변수에는 넣지 말 것. */
export const allowSignup: boolean = import.meta.env.VITE_ALLOW_SIGNUP === '1';

const DOMAIN = import.meta.env.VITE_STUDENT_DOMAIN ?? 'cities19.local';

export class AuthError extends Error {}

/** "7" -> "s07@도메인". 숫자가 아니면 그대로 앞에 붙인다. */
export function loginIdToEmail(loginId: string): string {
  const id = loginId.trim().toLowerCase();
  if (!id) throw new AuthError('번호를 입력해 주세요.');
  if (!/^[a-z0-9_-]+$/.test(id)) {
    throw new AuthError('번호는 영문·숫자만 쓸 수 있습니다.');
  }
  const local = /^\d+$/.test(id) ? `s${id.padStart(2, '0')}` : id;
  return `${local}@${DOMAIN}`;
}

function emailToLoginId(email: string | null): string {
  if (!email) return '?';
  const local = email.split('@')[0];
  return /^s\d+$/.test(local) ? String(Number(local.slice(1))) : local;
}

function toSession(user: User): Session {
  return { uid: user.uid, loginId: emailToLoginId(user.email) };
}

/**
 * 저장된 세션이 살아있는지 본다.
 * 로그인한 적이 있으면 Session, 없으면 null. Firebase 가 없으면 null.
 */
export function restoreSession(): Promise<Session | null> {
  const fb = getFirebase();
  if (!fb) return Promise.resolve(null);
  return new Promise((resolve) => {
    const stop = onAuthStateChanged(
      fb.auth,
      (user) => {
        stop();
        resolve(user ? toSession(user) : null);
      },
      (err) => {
        stop();
        console.error('세션 확인 실패', err);
        resolve(null);
      },
    );
  });
}

export async function signIn(loginId: string, password: string): Promise<Session> {
  const fb = getFirebase();
  if (!fb) throw new AuthError('서버 설정이 없어 로그인할 수 없습니다.');
  const email = loginIdToEmail(loginId);
  if (password.length < 6) {
    throw new AuthError('비밀번호는 6자 이상입니다.');
  }
  try {
    // 기기에 세션을 남긴다. 아이패드에서 매번 다시 로그인하지 않게.
    await setPersistence(fb.auth, browserLocalPersistence);
    const cred = await signInWithEmailAndPassword(fb.auth, email, password);
    return toSession(cred.user);
  } catch (err) {
    throw new AuthError(describeAuthError(err));
  }
}

/** allowSignup 이 켜져 있을 때만 쓴다. 학생용 화면에는 노출되지 않는다. */
export async function createAccount(
  loginId: string,
  password: string,
): Promise<Session> {
  const fb = getFirebase();
  if (!fb) throw new AuthError('서버 설정이 없습니다.');
  if (!allowSignup) throw new AuthError('계정 생성이 꺼져 있습니다.');
  try {
    await setPersistence(fb.auth, browserLocalPersistence);
    const cred = await createUserWithEmailAndPassword(
      fb.auth,
      loginIdToEmail(loginId),
      password,
    );
    return toSession(cred.user);
  } catch (err) {
    throw new AuthError(describeAuthError(err));
  }
}

export async function signOut(): Promise<void> {
  const fb = getFirebase();
  if (!fb) return;
  await fbSignOut(fb.auth);
}

/** Firebase 오류 코드를 학생이 읽을 수 있는 말로 바꾼다. */
function describeAuthError(err: unknown): string {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code: unknown }).code)
      : '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return '번호나 비밀번호가 맞지 않습니다.';
    case 'auth/too-many-requests':
      return '너무 여러 번 틀렸습니다. 잠시 뒤에 다시 해주세요.';
    case 'auth/network-request-failed':
      return '인터넷 연결을 확인해 주세요.';
    case 'auth/email-already-in-use':
      return '이미 있는 번호입니다.';
    case 'auth/weak-password':
      return '비밀번호가 너무 짧습니다.';
    case 'auth/operation-not-allowed':
      return '콘솔에서 이메일/비밀번호 로그인을 켜야 합니다.';
    default:
      console.error('로그인 실패', err);
      return '로그인에 실패했습니다. 선생님께 말해주세요.';
  }
}
