import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';

/**
 * Firebase 를 딱 한 번만 초기화한다.
 *
 * 설정값이 하나라도 비어 있으면 초기화하지 않고 null 을 돌려준다.
 * 이 경우 게임은 **오프라인 모드**로 뜬다 — 0단계 렌더러는 그대로 돌아가고
 * 저장만 꺼진다. 설정 실수로 학생들이 흰 화면을 보는 일이 없게 하려는 것이다.
 */

export interface FirebaseHandles {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
}

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? '',
};

/** 설정이 다 들어와 있는가. 로그인 화면이 이 값을 보고 안내 문구를 바꾼다. */
export const firebaseConfigured: boolean = Object.values(config).every(
  (v) => v.length > 0,
);

let handles: FirebaseHandles | null = null;
let failed = false;

export function getFirebase(): FirebaseHandles | null {
  if (handles) return handles;
  if (failed || !firebaseConfigured) return null;
  try {
    const app = initializeApp(config);
    handles = { app, auth: getAuth(app), db: getFirestore(app) };
    return handles;
  } catch (err) {
    console.error('Firebase 초기화 실패', err);
    failed = true;
    return null;
  }
}
