/// <reference types="vite/client" />

/**
 * Vercel 환경변수 타입.
 * VITE_ 로 시작하는 값만 클라이언트 번들에 들어간다.
 * Firebase 웹 설정값은 원래 공개되는 값이므로 여기 노출돼도 문제없다.
 * 진짜 비밀(서비스 계정 키)은 절대 VITE_ 로 시작하게 두면 안 된다.
 */
interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
