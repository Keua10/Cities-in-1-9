import { OVERRIDE_NONE } from '../core/constants';

/**
 * 청크 오버레이(4096칸)를 문자열로 압축한다.
 *
 * 왜 압축하나:
 *   Firestore 문서 하나는 1MB 가 넘으면 안 되고, 학생 20명이 Spark 무료 한도
 *   안에서 돌아야 한다. 4096칸을 그대로 넣으면 청크마다 5.5KB 씩 나가는데,
 *   실제로 학생이 고치는 타일은 초반에 수십 개뿐이다.
 *
 * 형식: [값, 길이하위8비트, 길이상위8비트] 를 반복하는 런렝스 부호화 → base64.
 *   - "안 바뀐 칸"(OVERRIDE_NONE) 이 길게 이어지므로 초반에는 청크당 수십 바이트다.
 *   - 최악(모든 칸이 옆칸과 다름)이라도 4096런 x 3바이트 = 12KB → base64 16KB.
 *     문서 한도의 2% 도 안 된다.
 *
 * 형식을 바꾸면 constants.ts 의 SCHEMA_VERSION 을 올려야 한다.
 */

const MAX_RUN = 0xffff;

/** 전부 "안 바뀜" 이면 null 을 돌려준다. 그러면 문서 자체를 안 만든다. */
export function encodeOverride(arr: Uint8Array | null | undefined): string | null {
  if (!arr) return null;

  let hasAny = false;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] !== OVERRIDE_NONE) {
      hasAny = true;
      break;
    }
  }
  if (!hasAny) return null;

  const out: number[] = [];
  let i = 0;
  while (i < arr.length) {
    const v = arr[i];
    let run = 1;
    while (i + run < arr.length && arr[i + run] === v && run < MAX_RUN) run++;
    out.push(v, run & 0xff, (run >> 8) & 0xff);
    i += run;
  }

  return bytesToBase64(Uint8Array.from(out));
}

/**
 * 문자열을 다시 4096칸 배열로 푼다.
 * 값이 없거나 깨져 있으면 null 을 돌려준다 — 저장 데이터가 이상해도
 * 게임이 죽지 않고 "생성된 지형 그대로" 로 떨어지게 하기 위해서다.
 */
export function decodeOverride(
  text: string | null | undefined,
  length: number,
): Uint8Array | null {
  if (!text) return null;

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(text);
  } catch {
    console.warn('오버레이 복호화 실패: base64 가 깨졌습니다.');
    return null;
  }
  if (bytes.length % 3 !== 0) {
    console.warn('오버레이 복호화 실패: 길이가 3의 배수가 아닙니다.');
    return null;
  }

  const arr = new Uint8Array(length).fill(OVERRIDE_NONE);
  let pos = 0;
  for (let p = 0; p < bytes.length; p += 3) {
    const v = bytes[p];
    const run = bytes[p + 1] | (bytes[p + 2] << 8);
    if (run === 0 || pos + run > length) {
      console.warn('오버레이 복호화 실패: 런 길이가 범위를 벗어났습니다.');
      return null;
    }
    if (v !== OVERRIDE_NONE) arr.fill(v, pos, pos + run);
    pos += run;
  }
  if (pos !== length) {
    console.warn('오버레이 복호화 실패: 칸 수가 모자랍니다.');
    return null;
  }
  return arr;
}

/* ---------------- base64 ---------------- */

function bytesToBase64(bytes: Uint8Array): string {
  // 인자를 한 번에 다 넘기면 배열이 클 때 스택이 넘친다. 8KB 씩 끊는다.
  let bin = '';
  const step = 0x2000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

function base64ToBytes(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
