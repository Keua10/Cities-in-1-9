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
  /** 학생 번호를 이메일로 바꿀 때 붙이는 도메인. 실제로 메일이 가지는 않는다. */
  readonly VITE_STUDENT_DOMAIN?: string;
  /** '1' 일 때만 로그인 화면에 계정 생성 버튼이 뜬다. 배포에는 절대 넣지 말 것. */
  readonly VITE_ALLOW_SIGNUP?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
