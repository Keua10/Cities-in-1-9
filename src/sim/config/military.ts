/**
 * 군대 (군사 4단계~). 설계안 v0.2 Ⅴ·Ⅵ·Ⅶ 장.
 *
 * 수치는 상대 비교용이다. 보병 = 공격 10 · 방어 10 이 기준. 엔드 콘텐츠 전까지는 보병이
 * 주력이 되도록 보병만 싸고 빨리 뽑힌다. 비용 단위는 만 원, 자원은 단위 수량.
 * 이동 속도는 "청크/분"(실제 시간, 전쟁 1배속 기준).
 */

export const FAC_BARRACKS = 48;
export const FAC_TRENCH = 49;

export type UnitType =
  | 'infantry'
  | 'engineer'
  | 'artillery'
  | 'armor'
  | 'aa'
  | 'fighter'
  | 'bomber'
  | 'ship'
  | 'missile';

export interface UnitSpec {
  name: string;
  role: string;
  /** 생산 시설 kind. */
  facility: number;
  /** 해금 도시 레벨. */
  unlock: number;
  /** 생산 시간(실제 초). */
  buildSec: number;
  cost: number;
  iron: number;
  coal: number;
  oil: number;
  /** 하루 유지비(돈·식량·석유). */
  upkeep: number;
  food: number;
  fuel: number;
  attack: number;
  defense: number;
  /** 청크/분. */
  speed: number;
  /** 한 부대 인원(징병). 0 이면 징병 없이 기계만. */
  men: number;
  strongVs: UnitType[];
  weakVs: UnitType[];
  /** 산을 넘을 수 있는가. */
  mountains: boolean;
  /** 지금 단계에서 뽑을 수 있는가(4단계는 보병·공병·포병만). */
  available: boolean;
}

const MIN = 60;

export const UNIT_SPECS: Record<UnitType, UnitSpec> = {
  infantry: {
    name: '보병',
    role: '점령·방어·시가전',
    facility: FAC_BARRACKS,
    unlock: 3,
    buildSec: 1 * MIN,
    cost: 300,
    iron: 2,
    coal: 0,
    oil: 0,
    upkeep: 20,
    food: 500,
    fuel: 0,
    attack: 10,
    defense: 10,
    speed: 3,
    men: 500,
    strongVs: [],
    weakVs: ['armor'],
    mountains: true,
    available: true,
  },
  engineer: {
    name: '공병',
    role: '다리·참호·강 건너기',
    facility: FAC_BARRACKS,
    unlock: 4,
    buildSec: 3 * MIN,
    cost: 600,
    iron: 5,
    coal: 0,
    oil: 0,
    upkeep: 30,
    food: 500,
    fuel: 0,
    attack: 4,
    defense: 8,
    speed: 3,
    men: 500,
    strongVs: [],
    weakVs: ['armor'],
    mountains: true,
    available: true,
  },
  artillery: {
    name: '포병',
    role: '원거리 지원',
    facility: FAC_BARRACKS,
    unlock: 4,
    buildSec: 5 * MIN,
    cost: 1_200,
    iron: 15,
    coal: 5,
    oil: 0,
    upkeep: 60,
    food: 300,
    fuel: 0,
    attack: 16,
    defense: 4,
    speed: 1.8,
    men: 300,
    strongVs: ['armor', 'infantry'],
    weakVs: ['armor'],
    mountains: false,
    available: true,
  },
  armor: {
    name: '기갑',
    role: '평지 돌파',
    facility: -1,
    unlock: 5,
    buildSec: 10 * MIN,
    cost: 4_000,
    iron: 60,
    coal: 0,
    oil: 10,
    upkeep: 150,
    food: 0,
    fuel: 5,
    attack: 28,
    defense: 18,
    speed: 6,
    men: 0,
    strongVs: ['infantry'],
    weakVs: ['artillery'],
    mountains: false,
    available: false,
  },
  aa: {
    name: '대공',
    role: '공군 방어',
    facility: FAC_BARRACKS,
    unlock: 6,
    buildSec: 5 * MIN,
    cost: 1_500,
    iron: 20,
    coal: 0,
    oil: 0,
    upkeep: 60,
    food: 300,
    fuel: 0,
    attack: 4,
    defense: 12,
    speed: 1.8,
    men: 300,
    strongVs: ['fighter', 'bomber'],
    weakVs: [],
    mountains: false,
    available: false,
  },
  fighter: {
    name: '전투기',
    role: '제공권',
    facility: -1,
    unlock: 6,
    buildSec: 15 * MIN,
    cost: 8_000,
    iron: 40,
    coal: 0,
    oil: 20,
    upkeep: 300,
    food: 0,
    fuel: 10,
    attack: 20,
    defense: 10,
    speed: 20,
    men: 0,
    strongVs: ['bomber'],
    weakVs: ['aa'],
    mountains: true,
    available: false,
  },
  bomber: {
    name: '폭격기',
    role: '시설 파괴',
    facility: -1,
    unlock: 8,
    buildSec: 30 * MIN,
    cost: 15_000,
    iron: 60,
    coal: 0,
    oil: 40,
    upkeep: 500,
    food: 0,
    fuel: 20,
    attack: 35,
    defense: 6,
    speed: 20,
    men: 0,
    strongVs: ['artillery'],
    weakVs: ['fighter', 'aa'],
    mountains: true,
    available: false,
  },
  ship: {
    name: '군함',
    role: '해상·상륙 지원',
    facility: -1,
    unlock: 7,
    buildSec: 40 * MIN,
    cost: 20_000,
    iron: 150,
    coal: 0,
    oil: 40,
    upkeep: 600,
    food: 0,
    fuel: 25,
    attack: 30,
    defense: 30,
    speed: 6,
    men: 0,
    strongVs: [],
    weakVs: ['bomber'],
    mountains: false,
    available: false,
  },
  missile: {
    name: '미사일',
    role: '원거리 타격(1회)',
    facility: -1,
    unlock: 9,
    buildSec: 60 * MIN,
    cost: 40_000,
    iron: 100,
    coal: 0,
    oil: 60,
    upkeep: 100,
    food: 0,
    fuel: 0,
    attack: 80,
    defense: 0,
    speed: 0,
    men: 0,
    strongVs: [],
    weakVs: [],
    mountains: true,
    available: false,
  },
};

/** 상성: 강한 상대에게 ×1.5, 약한 상대에게 ×0.67. */
export const MATCHUP_STRONG = 1.5;
export const MATCHUP_WEAK = 0.67;

/* ---------------- 징병 ---------------- */

/** 한 청크에서 뽑을 수 있는 최대치: 거주 인구의 20%. */
export const DRAFT_SHARE = 0.2;

/* ---------------- 전투 ---------------- */

/** 전투 틱(실제 ms). */
export const COMBAT_TICK_MS = 1_000;
/** 받은 피해 1당 조직력 손실 (방어 10, 보정 없음 기준). 같은 보병끼리면 약 1분 버틴다. */
export const ORG_LOSS_PER_DAMAGE = 0.17;
/** 받은 피해 1당 병력 손실(명). 같은 보병끼리 1분이면 약 10%. */
export const MEN_LOSS_PER_DAMAGE = 0.08;
export const ORG_MAX = 100;
/** 내 영토에서 쉬면 초당 회복(병원 근처면 2배는 화면 단계에서). */
export const ORG_REGEN_PER_SEC = 0.5;
/** 보급이 끊기면 초당 조직력·사기 감소. */
export const UNSUPPLIED_ORG_DECAY = 0.2;
export const UNSUPPLIED_MORALE_DECAY = 0.002;
/** 적 부대가 없는 적 청크에 이만큼 머물면 점령. */
export const OCCUPY_SECONDS = 60;
/** 부대 시야(청크). */
export const VISION_CHUNKS = 2;
/** 참호·벙커가 있는 청크 방어 보너스. */
export const TRENCH_DEFENSE = 0.3;
/** 매복: 골짜기에서 숨어 있던 쪽 첫 30초 공격 +50%. */
export const AMBUSH_BONUS = 0.5;
export const AMBUSH_SECONDS = 30;
