/**
 * 도시 생성 전용 난수.
 *
 * 기존 생성기는 좌표 해시(simRandom)만 썼다. 좌표가 같으면 결과도 같으므로
 * "맵 초기화" 를 눌러도 **매번 똑같은 도시** 가 나왔다. 생성마다 다른 도시를
 * 만들려면 좌표가 아니라 **생성 단위의 씨앗** 이 필요하다.
 *
 * 그렇다고 Math.random 을 직접 쓸 수는 없다. 씨앗을 저장해 두면 같은 도시를
 * 다시 만들 수 있어야 하고(저장 실패·검사 재현), 검사 코드가 같은 씨앗으로
 * 같은 도시를 얻어야 하기 때문이다. 그래서 씨앗 하나로 굴러가는 mulberry32 를
 * 쓴다 — 32비트 상태 하나, 곱셈 두 번이면 끝이라 12만 칸을 훑어도 부담이 없다.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // 0 은 mulberry32 의 고정점이다. 씨앗이 0 이어도 굴러가게 밀어 둔다.
    this.state = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0;
  }

  /** 0 이상 1 미만. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** a 이상 b 미만의 실수. */
  range(a: number, b: number): number {
    return a + this.next() * (b - a);
  }

  /** 0 이상 n 미만의 정수. */
  int(n: number): number {
    return Math.floor(this.next() * n) % Math.max(1, n);
  }

  /** a 이상 b 이하의 정수. */
  between(a: number, b: number): number {
    return a + this.int(b - a + 1);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }

  /** 제자리 셔플(Fisher-Yates). */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = items[i];
      items[i] = items[j];
      items[j] = t;
    }
    return items;
  }
}

/** 저장된 씨앗이 없을 때 쓸 새 씨앗. */
export function randomCitySeed(): number {
  return (Math.floor(Math.random() * 0xffffffff) | 0) >>> 0;
}

/** 씨앗 하나에서 파생 씨앗을 만든다. 단계마다 독립된 난수열을 쓰기 위한 것이다. */
export function deriveSeed(seed: number, salt: number): number {
  let h = (seed ^ Math.imul(salt | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
