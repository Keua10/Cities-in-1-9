import type { TutorialState } from '../net/types';
import type { MacroSim } from '../sim/macro';
import { FACILITY_SPECS } from '../sim/facilities';
import { FACILITY_UNLOCK_LEVEL } from '../sim/progression';
import { POWER_SPECS, WIRE_COST } from '../sim/config/power';
import { PIPE_COST, WATER_SPECS } from '../sim/config/water';
import { COST_ROAD, COST_ZONE } from '../sim/config/macro';
import { formatMoney } from './money';
import type { ToolId, Tools } from './tools';

/**
 * 튜토리얼 (피드백 2차).
 *
 * - 처음 들어오면 "튜토리얼 / 건너뛰기" 를 고른다.
 * - 기본 튜토리얼은 "이런 것들이 있다" 정도만 짧게 짚는다. 깊이 들어가지 않는다.
 * - 직접 지어 보는 단계는 **튜토리얼이 돈을 대 준다**("이번에는 제가 돈을 직접 내드릴게요!").
 *   단계마다 한 번만 주고(paid), 상태는 도시 저장에 같이 실려서 새로고침해도 다시 주지 않는다.
 * - 작동 방식이 다른 건물(군사·광산·자원 공장·공항/항구 등)이 열리면 그때 한 장짜리 안내를 띄운다.
 *   2단계(대형) 시설처럼 기존 건물의 큰 버전은 안내하지 않는다.
 */

interface Step {
  title: string;
  body: string;
  /** 이 단계에서 대 주는 돈. 있으면 단계 시작 때 지급한다. */
  pay?: number;
  /** 할 일. 있으면 그 행동을 하면 다음 단계로 넘어간다. */
  task?: string;
  done?: (tool: ToolId, kind: number) => boolean;
}

const ROAD_PAY = COST_ROAD * 60;
const ZONE_PAY = COST_ZONE * 120;
const WIND_KIND = 11;
const POWER_PAY = FACILITY_SPECS[WIND_KIND].cost + WIRE_COST * 30;
const WATER_PAY = FACILITY_SPECS[7].cost + FACILITY_SPECS[9].cost + PIPE_COST * 60;

const STEPS: readonly Step[] = [
  {
    title: '어서 오세요, 시장님!',
    body: '여기는 우리 도시예요. 한 손가락(마우스)으로 끌면 지도가 움직이고, 두 손가락(휠)으로 확대·축소해요. 짧게 몇 가지만 같이 해 볼게요.',
  },
  {
    title: '1. 도로 놓기',
    body: '모든 건물은 도로로 이어져야 해요. 왼쪽 [교통] → 도로를 고르고, 시작점과 끝점을 누른 뒤 ✓ 를 눌러요. 꾹 누른 채 끌어도 돼요.',
    pay: ROAD_PAY,
    task: '도로를 한 줄 놓아 보세요',
    done: (tool) => tool === 'road',
  },
  {
    title: '2. 구역 칠하기',
    body: '도로 옆에 주거·상업·공업 구역을 칠하면 사람들이 알아서 건물을 지어요. 왼쪽 [구역] 에서 고르고 두 모서리를 눌러 범위를 정해요.',
    pay: ZONE_PAY,
    task: '구역을 한 번 칠해 보세요',
    done: (tool) => tool === 'zoneR' || tool === 'zoneC' || tool === 'zoneI',
  },
  {
    title: '3. 전기',
    body: '건물은 전기가 있어야 자라요. 왼쪽 [전기] 에서 발전소를 짓고, 전선으로 도시까지 이어요. 풍력 발전소가 가장 싸요.',
    pay: POWER_PAY,
    task: '발전소를 하나 지어 보세요',
    done: (tool, kind) => tool === 'facility' && !!POWER_SPECS[kind],
  },
  {
    title: '4. 상수도·하수도',
    body: '물도 필요해요. 왼쪽 [수도] 에서 펌프(급수)와 방류구·처리장(하수)을 짓고 배관으로 이어요. 배관은 도로처럼 직접 이은 칸끼리만 연결되고, 옆에 붙어 있기만 해서는 안 이어져요.',
    pay: WATER_PAY,
    task: '급수나 하수 시설을 하나 지어 보세요',
    done: (tool, kind) => tool === 'facility' && !!WATER_SPECS[kind],
  },
  {
    title: '5. 공공시설',
    body: '소방서·경찰서·병원·학교는 도로로 닿는 범위의 건물을 돌봐요. 도시가 커지면 더 큰 2단계 시설(대형 소방서·종합병원 등)이 열려요.',
  },
  {
    title: '6. 대륙과 시간',
    body: '대륙 지도에서 이웃 도시를 볼 수 있어요. 시간은 모두가 같이 쓰고, 대륙 어디에도 전쟁이 없을 때는 2배로 흘러요. 영토·수도 옮기기는 도시 패널에서 해요.',
  },
  {
    title: '이제 시작이에요!',
    body: '나머지는 해 보면서 알아가면 돼요. 새로운 종류의 건물이 열리면 그때 짧게 알려 드릴게요.',
  },
];

interface Topic {
  id: string;
  kinds: readonly number[];
  title: string;
  body: string;
}

/** 작동 방식이 기존 건물과 다른 것만. 2단계(대형) 시설은 넣지 않는다. */
const TOPICS: readonly Topic[] = [
  {
    id: 'mine',
    kinds: [36, 37, 38],
    title: '광산이 열렸어요',
    body: '철·석탄·석유 매장지가 있는 곳에만 지을 수 있어요(광산을 고르면 매장지가 보여요). 캔 자원은 다른 시설이 쓰고, 다 캐면 멈춰요.',
  },
  {
    id: 'tower',
    kinds: [50],
    title: '점령타워가 열렸어요',
    body: '영토를 넓히는 건물이에요. 수도와 길로 이어져 있어야 영토가 유지돼요.',
  },
  {
    id: 'scout',
    kinds: [59],
    title: '정찰타워가 열렸어요',
    body: '주변의 안개를 걷어 다른 도시와 부대의 움직임을 볼 수 있어요.',
  },
  {
    id: 'lumber',
    kinds: [60],
    title: '벌목장이 열렸어요',
    body: '숲 근처에 지으면 나무를 얻어요. 나무는 탄약 같은 다른 생산에 쓰여요.',
  },
  {
    id: 'military',
    kinds: [48, 49],
    title: '군사 시설이 열렸어요',
    body: '병영에서 부대를 만들고 참호·벙커로 지켜요. 전쟁은 대륙 지도에서 해요. 남의 영해·영공을 허락 없이 넘으면 공격받을 수 있어요.',
  },
  {
    id: 'consumer',
    kinds: [45, 46, 47],
    title: '자원을 쓰는 공장이 열렸어요',
    body: '제철소·정유소·석탄 화력은 광산에서 캔 자원을 받아 돌아가요. 원료가 떨어지면 멈춰요.',
  },
  {
    id: 'ammo',
    kinds: [61],
    title: '탄약 공장이 열렸어요',
    body: '자원으로 탄약을 만들어요. 부대가 싸울 때 탄약을 써요.',
  },
  {
    id: 'army2',
    kinds: [51, 52, 53, 54, 55, 56, 57, 58],
    title: '새 군사 기지가 열렸어요',
    body: '군수·전차·레이더·공군·해군·미사일 기지가 차례로 열려요. 기지마다 만들 수 있는 부대가 달라요.',
  },
  {
    id: 'transport',
    kinds: [18, 19, 21],
    title: '공항·항구가 열렸어요',
    body: '공항은 활주로와 유도로를 먼저 깔고 이어야 비행기가 다녀요. 항구는 물가에 지어요.',
  },
];

function topicLevel(t: Topic): number {
  return Math.min(...t.kinds.map((k) => FACILITY_UNLOCK_LEVEL[k] ?? 99));
}

export class Tutorial {
  private card: HTMLElement;
  private queue: Topic[] = [];
  private showingTopic: Topic | null = null;

  constructor(
    private sim: MacroSim,
    tools: Tools,
    private announce: (text: string) => void,
  ) {
    this.card = document.createElement('div');
    this.card.id = 'tutorial-card';
    this.card.hidden = true;
    document.body.append(this.card);
    const prev = tools.onPlaced;
    tools.onPlaced = (tool, kind) => {
      prev?.(tool, kind);
      this.placed(tool, kind);
    };
  }

  private get state(): TutorialState | undefined {
    return this.sim.state.tutorial;
  }

  private save(state: TutorialState): void {
    this.sim.state.tutorial = state;
    this.sim.onMacroChange?.();
  }

  /** 처음 들어왔을 때 부른다. 튜토리얼 상태가 없으면 고르게 한다. */
  start(): void {
    const s = this.state;
    if (!s) {
      // 이미 키워 둔 도시는 지금 레벨까지 열린 안내를 본 것으로 친다(한꺼번에 쏟아지지 않게).
      const level = this.sim.cityLevel;
      const seen = level > 1 ? TOPICS.filter((t) => topicLevel(t) <= level).map((t) => t.id) : [];
      this.save({ step: 0, paid: [], seen });
      this.renderChoice();
      return;
    }
    if (s.step >= 0) this.renderStep();
  }

  private renderChoice(): void {
    this.card.className = 'tut-choice';
    this.card.innerHTML = `
      <div class="tut-title">튜토리얼을 할까요?</div>
      <div class="tut-body">도로·구역·전기·물을 짧게 같이 해 봐요. 지어 보는 단계는 제가 돈을 대 드려요.</div>
      <div class="tut-actions">
        <button type="button" data-act="skip">건너뛰기</button>
        <button type="button" class="primary" data-act="go">튜토리얼 시작</button>
      </div>`;
    this.card.hidden = false;
    this.card.querySelector<HTMLButtonElement>('[data-act=go]')!.onclick = () => {
      this.goto(0);
    };
    this.card.querySelector<HTMLButtonElement>('[data-act=skip]')!.onclick = () => {
      this.finish();
      this.announce('튜토리얼을 건너뛰었습니다 · 새 건물이 열리면 짧게 안내합니다');
    };
  }

  private goto(step: number): void {
    const s = this.state ?? { step: 0, paid: [], seen: [] };
    if (step >= STEPS.length) {
      this.finish();
      return;
    }
    const next: TutorialState = { ...s, step };
    const pay = STEPS[step].pay;
    if (pay && !next.paid.includes(step)) {
      next.paid = [...next.paid, step];
      this.sim.adjustMoney(pay);
    }
    this.save(next);
    this.renderStep();
  }

  private finish(): void {
    const s = this.state ?? { step: -1, paid: [], seen: [] };
    this.save({ ...s, step: -1 });
    this.card.hidden = true;
    this.pump();
  }

  private renderStep(): void {
    const s = this.state;
    if (!s || s.step < 0) return;
    const step = STEPS[s.step];
    const paid = step.pay && s.paid.includes(s.step);
    this.card.className = 'tut-step';
    this.card.innerHTML = `
      <div class="tut-head"><span class="tut-count">${s.step + 1}/${STEPS.length}</span><span class="tut-title"></span></div>
      ${paid ? `<div class="tut-pay">💰 이번에는 제가 돈을 직접 내드릴게요! ${formatMoney(step.pay!, true)} 넣어 드렸어요.</div>` : ''}
      <div class="tut-body"></div>
      ${step.task ? `<div class="tut-task">할 일 · ${step.task}</div>` : ''}
      <div class="tut-actions">
        <button type="button" data-act="quit">그만하기</button>
        <button type="button" class="primary" data-act="next">${step.task ? '이 단계 넘기기' : s.step === STEPS.length - 1 ? '끝' : '다음'}</button>
      </div>`;
    this.card.querySelector('.tut-title')!.textContent = step.title;
    this.card.querySelector('.tut-body')!.textContent = step.body;
    this.card.hidden = false;
    this.card.querySelector<HTMLButtonElement>('[data-act=next]')!.onclick = () =>
      this.goto(s.step + 1);
    this.card.querySelector<HTMLButtonElement>('[data-act=quit]')!.onclick = () => this.finish();
  }

  private placed(tool: ToolId, kind: number): void {
    const s = this.state;
    if (!s || s.step < 0) return;
    const step = STEPS[s.step];
    if (step.done?.(tool, kind)) {
      this.announce(`잘했어요! ${step.title.replace(/^\d+\.\s*/, '')} 완료`);
      this.goto(s.step + 1);
    }
  }

  /** HUD 주기마다 부른다. 새로 열린 건물 안내를 띄운다. */
  tick(): void {
    const s = this.state;
    if (!s || s.step >= 0 || s.muted) return;
    const level = this.sim.cityLevel;
    for (const t of TOPICS) {
      if (s.seen.includes(t.id) || this.queue.includes(t) || this.showingTopic === t) continue;
      const lv = topicLevel(t);
      if (lv > 1 && lv <= level) this.queue.push(t);
    }
    this.pump();
  }

  private pump(): void {
    if (this.showingTopic || !this.queue.length) return;
    const s = this.state;
    if (!s || s.step >= 0) return;
    const t = this.queue.shift()!;
    this.showingTopic = t;
    this.card.className = 'tut-topic';
    this.card.innerHTML = `
      <div class="tut-head"><span class="tut-count">새 건물</span><span class="tut-title"></span></div>
      <div class="tut-body"></div>
      <div class="tut-actions">
        <button type="button" data-act="mute">안내 끄기</button>
        <button type="button" class="primary" data-act="ok">알겠어요</button>
      </div>`;
    this.card.querySelector('.tut-title')!.textContent = t.title;
    this.card.querySelector('.tut-body')!.textContent = t.body;
    this.card.hidden = false;
    const close = (mute: boolean) => {
      const cur = this.state ?? s;
      this.save({ ...cur, seen: [...cur.seen, t.id], ...(mute ? { muted: true } : {}) });
      this.showingTopic = null;
      this.card.hidden = true;
      if (mute) this.queue = [];
      else this.pump();
    };
    this.card.querySelector<HTMLButtonElement>('[data-act=ok]')!.onclick = () => close(false);
    this.card.querySelector<HTMLButtonElement>('[data-act=mute]')!.onclick = () => close(true);
  }
}
