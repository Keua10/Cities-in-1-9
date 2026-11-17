/**
 * 군대 (군사 4단계~). 설계안 v0.2 Ⅴ·Ⅵ·Ⅶ 장.
 *
 * 수치는 상대 비교용이다. 보병 = 공격 10 · 방어 10 이 기준. 엔드 콘텐츠 전까지는 보병이
 * 주력이 되도록 보병만 싸고 빨리 뽑힌다. 비용 단위는 만 원, 자원은 단위 수량.
 * 이동 속도는 "청크/분"(실제 시간, 전쟁 1배속 기준).
 */

export const FAC_BARRACKS = 48;
export const FAC_TRENCH = 49;
/** 점령타워: 내 영토와 맞닿은 무소유 청크에 세우면 실제 1시간 뒤 그 청크가 내 땅이 된다. */
export const FAC_OCC_TOWER = 50;
export const OCC_TOWER_MS = 60 * 60_000;
/* 군사 6단계 시설 */
/** 군수 공장: 포탄·장비, 모든 부대 생산 시간 -30%. */
export const FAC_MUNITIONS = 51;
export const FAC_TANK_FACTORY = 52;
/** 레이더: 시야 6청크, 공습 경보. */
export const FAC_RADAR = 53;
export const FAC_AIRBASE = 54;
export const FAC_NAVAL_BASE = 55;
export const FAC_AIRBASE_2 = 56;
export const FAC_MISSILE_BASE = 57;
export const FAC_MISSILE_DEFENSE = 58;
/** 군사 시설 전부(내 영토에만). */
export const MILITARY_FACILITIES = [48, 49, 51, 52, 53, 54, 55, 56, 57, 58] as const;

/** 땅·하늘·바다·발사체. */
export type UnitDomain = 'ground' | 'air' | 'sea' | 'strike';

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
  domain: UnitDomain;
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
  /** 지금 단계에서 뽑을 수 있는가(4단계는 보병·공병·포병만, 6단계부터 전부). */
  available: boolean;
}

const MIN = 60;

export const UNIT_SPECS: Record<UnitType, UnitSpec> = {
  infantry: {
    name: '보병',
    domain: 'ground',
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
    domain: 'ground',
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
    domain: 'ground',
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
    domain: 'ground',
    role: '평지 돌파',
    facility: FAC_TANK_FACTORY,
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
    available: true,
  },
  aa: {
    name: '대공',
    domain: 'ground',
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
    available: true,
  },
  fighter: {
    name: '전투기',
    domain: 'air',
    role: '제공권',
    facility: FAC_AIRBASE,
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
    available: true,
  },
  bomber: {
    name: '폭격기',
    domain: 'air',
    role: '시설 파괴',
    facility: FAC_AIRBASE_2,
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
    available: true,
  },
  ship: {
    name: '군함',
    domain: 'sea',
    role: '해상·상륙 지원',
    facility: FAC_NAVAL_BASE,
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
    available: true,
  },
  missile: {
    name: '미사일',
    domain: 'strike',
    role: '원거리 타격(1회)',
    facility: FAC_MISSILE_BASE,
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
    available: true,
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

/* ---------------- 6단계: 기계 부대·하늘·바다·미사일 ---------------- */

/** 기계 부대(사람을 뽑지 않는 병종)의 전력 점수. 사람 부대의 인원 자리에 쓴다. */
export const MACHINE_STRENGTH = 100;

/** 부대 하나의 가득 찬 전력(사람이면 인원, 기계면 MACHINE_STRENGTH). */
export function unitStrength(type: UnitType): number {
  return UNIT_SPECS[type].men || MACHINE_STRENGTH;
}

/** 전력이 이 비율 밑으로 떨어지면 전멸. 보병 500명이면 30명. */
export const DESTROYED_SHARE = 0.06;

/** 공군은 내 땅(점령지 포함)에서 이 청크 안까지만 날아간다. */
export const AIR_RANGE_CHUNKS = 12;
/** 미사일 사거리(미사일 기지에서). */
export const MISSILE_RANGE_CHUNKS = 60;
/** 군수 공장이 있으면 생산 시간 −30%. */
export const MUNITIONS_SPEEDUP = 0.3;
/** 레이더 시야(청크). */
export const RADAR_VISION_CHUNKS = 6;
/** 미사일 방어 시설: 이 거리 안 표적을 지키고, 이 확률로 요격한다. */
export const MISSILE_DEFENSE_RANGE = 8;
export const MISSILE_DEFENSE_INTERCEPT = 0.6;
/** 표적 청크의 대공 부대 하나당 요격 확률(최대 AA_INTERCEPT_MAX). */
export const AA_INTERCEPT_EACH = 0.1;
export const AA_INTERCEPT_MAX = 0.3;
/** 미사일이 떨어진 청크의 부대: 전력 −40%, 조직력 −60. */
export const MISSILE_UNIT_LOSS = 0.4;
export const MISSILE_ORG_LOSS = 60;
/** 시설 파괴력: 공격력 1당 부술 수 있는 시설 건설비(만 원). */
export const MISSILE_FACILITY_VALUE = 1_000;
export const BOMB_FACILITY_VALUE = 300;
/** 폭격기는 적 땅 위에서 이 간격마다 폭탄을 떨어뜨린다. */
export const BOMB_INTERVAL_MS = 60_000;
/** 대공 부대 하나가 폭격 위력을 줄이는 비율(같은·이웃 청크, 최대 60%). */
export const AA_BOMB_REDUCE_EACH = 0.15;
export const AA_BOMB_REDUCE_MAX = 0.6;
/** 군함 함포: 바다에 붙은 땅 청크를 이 배율로 친다. */
export const SHORE_BOMBARD = 0.7;
/** 전투기가 땅·바다 부대를 칠 때 배율. */
export const FIGHTER_VS_SURFACE = 0.5;
/** 해군 기지가 있으면 땅 부대가 배를 타고 바다를 건넌다(이동 배율). 바다 위에서는 싸우지 못한다. */
export const EMBARKED_MOVE = 0.3;
