import { FACILITY_SPECS } from '../sim/facilities';
import {
  AIRPORT_VISITORS_PER_PLANE,
  CARGO_EXPORT_PER_SHIP,
  HARBOR_SPECS,
  PASSENGER_LOCAL_TRIPS_PER_SHIP,
  PASSENGER_VISITORS_PER_SHIP,
} from '../sim/config/transport';
import { isAirportFacility, isHarborFacility } from '../sim/config/special';
import type { TransportHubStatus, TransportSystem } from '../sim/transportHubs';
import type { World } from '../world/world';

/** Click/tap popup for airport and harbor operations. */
export class TransportHubPanel {
  private root: HTMLDivElement;
  private body: HTMLDivElement;
  private selected: { tx: number; ty: number } | null = null;
  private lastHtml = '';

  constructor(
    private world: World,
    private transport: TransportSystem,
  ) {
    this.root = document.createElement('div');
    this.root.id = 'transport-hub-panel';
    this.root.hidden = true;
    Object.assign(this.root.style, {
      position: 'fixed',
      right: '12px',
      bottom: '88px',
      zIndex: '40',
      width: 'min(340px, calc(100vw - 24px))',
      maxHeight: 'calc(100vh - 120px)',
      overflow: 'auto',
      boxSizing: 'border-box',
      padding: '12px',
      borderRadius: '12px',
      border: '1px solid rgba(255,255,255,0.18)',
      background: 'rgba(16, 22, 27, 0.96)',
      color: '#eef2f4',
      boxShadow: '0 10px 34px rgba(0,0,0,0.36)',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '13px',
      lineHeight: '1.45',
    });

    const head = document.createElement('div');
    Object.assign(head.style, { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' });
    const title = document.createElement('b');
    title.textContent = '교통 시설 운영';
    title.style.flex = '1';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '닫기';
    close.addEventListener('click', () => this.hide());
    Object.assign(close.style, buttonStyle());
    head.append(title, close);
    this.root.appendChild(head);

    this.body = document.createElement('div');
    this.root.appendChild(this.body);
    document.body.appendChild(this.root);
  }

  showAt(tx: number, ty: number): void {
    const info = this.world.buildingCovering(tx, ty);
    if (!info || info.kind === null || (!isAirportFacility(info.kind) && !isHarborFacility(info.kind))) {
      this.hide();
      return;
    }
    this.selected = { tx: info.tx, ty: info.ty };
    this.root.hidden = false;
    this.paint(true);
  }

  update(): void {
    if (this.root.hidden || !this.selected) return;
    this.paint(false);
  }

  hide(): void {
    this.selected = null;
    this.root.hidden = true;
    this.lastHtml = '';
  }

  private paint(force: boolean): void {
    if (!this.selected) return;
    const status = this.transport.statusAt(this.selected.tx, this.selected.ty);
    if (!status) {
      this.hide();
      return;
    }

    const html = this.describe(status);
    // Do not rebuild range controls every frame while the user is dragging them.
    if (!force && html === this.lastHtml) return;
    this.lastHtml = html;
    this.body.innerHTML = html;

    if (status.harbor?.hybrid) this.bindHybridControls(status);
  }

  private describe(status: TransportHubStatus): string {
    const name = FACILITY_SPECS[status.kind].name;
    const state = status.operational ? '가동 중' : '가동 중지';
    const common =
      `<div style="font-size:16px;font-weight:700;margin-bottom:4px">${name}</div>` +
      `<div style="margin-bottom:8px">${status.span}×${status.span} · ${status.level}단계 · <b>${state}</b></div>` +
      `<div>도로 ${status.road ? '연결' : '미연결'} · 전력 ${Math.round(status.power * 100)}%</div>`;

    if (status.airport) {
      const a = status.airport;
      const field = a.airfield;
      return (
        common +
        `<div>항공기 ${a.activePlanes}/${a.maxPlanes}대 운항 · 방문객 ${a.activePlanes * AIRPORT_VISITORS_PER_PLANE}명/일</div>` +
        `<div>유도로 ${field.taxiwayConnected ? '터미널 연결' : '미연결'}</div>` +
        `<div>활주로 최장 ${field.longestRunway}/${field.requiredRunway}칸 · 연결 활주로 ${field.connectedRunwayTiles}칸</div>` +
        `<div style="margin-top:8px;color:#c8d3d9">시설 메뉴의 유도로로 터미널을 활주로에 연결해야 운항합니다. 활주로는 일직선 최소 길이를 충족해야 합니다.</div>`
      );
    }

    const h = status.harbor!;
    const total = h.passengerShips + h.cargoShips;
    const water = status.water ? '인접' : '미인접';
    let extra = `<div>수역 ${water} · 운용 ${total}/${h.maxShips}척</div>`;
    extra += `<div>여객선 ${h.passengerShips}척 · 화물선 ${h.cargoShips}척</div>`;
    const citywide = this.transport.summary();
    const localTrips = citywide.passengerHarbors >= 2
      ? h.passengerShips * PASSENGER_LOCAL_TRIPS_PER_SHIP
      : 0;
    extra += `<div>방문객 ${h.passengerShips * PASSENGER_VISITORS_PER_SHIP}명/일 · 수상교통 ${localTrips}회/일 · 화물 수출수요 +${h.cargoShips * CARGO_EXPORT_PER_SHIP}</div>`;
    if (h.passengerShips > 0 && citywide.passengerHarbors < 2)
      extra += '<div style="color:#d9b870">도시 내 수상교통은 가동 중인 여객 항구가 2곳 이상 있어야 연결됩니다.</div>';
    if (h.hybrid) {
      const alloc = this.transport.allocationAt(status.tx, status.ty, status.kind)!;
      extra +=
        `<div style="margin-top:10px"><b>선박 배분</b></div>` +
        rangeHtml('passenger', '여객선', alloc.passenger, h.maxShips) +
        rangeHtml('cargo', '화물선', alloc.cargo, h.maxShips) +
        `<div id="hub-ship-total" style="margin-top:5px">설정 합계 ${alloc.passenger + alloc.cargo}/${h.maxShips}척</div>`;
    } else {
      const mode = HARBOR_SPECS[status.kind]?.mode === 'cargo' ? '화물 전용' : '여객 전용';
      extra += `<div style="margin-top:8px;color:#c8d3d9">${mode} 항구입니다. 5×5 이상 복합항부터 여객/화물 선박을 함께 배분할 수 있습니다.</div>`;
    }
    return common + extra;
  }

  private bindHybridControls(status: TransportHubStatus): void {
    const p = this.body.querySelector<HTMLInputElement>('#hub-passenger');
    const c = this.body.querySelector<HTMLInputElement>('#hub-cargo');
    const pv = this.body.querySelector<HTMLElement>('#hub-passenger-value');
    const cv = this.body.querySelector<HTMLElement>('#hub-cargo-value');
    const total = this.body.querySelector<HTMLElement>('#hub-ship-total');
    if (!p || !c || !pv || !cv || !total || !status.harbor) return;

    const apply = (prefer: 'passenger' | 'cargo') => {
      const next = this.transport.setHarborAllocation(
        status.tx,
        status.ty,
        Number(p.value),
        Number(c.value),
        prefer,
      );
      if (!next) return;
      p.value = String(next.passenger);
      c.value = String(next.cargo);
      pv.textContent = String(next.passenger);
      cv.textContent = String(next.cargo);
      total.textContent = `설정 합계 ${next.passenger + next.cargo}/${status.harbor!.maxShips}척`;
      this.lastHtml = '';
    };

    p.addEventListener('input', () => apply('passenger'));
    c.addEventListener('input', () => apply('cargo'));
  }
}

function rangeHtml(id: string, label: string, value: number, max: number): string {
  return (
    `<label style="display:grid;grid-template-columns:64px 1fr 24px;gap:7px;align-items:center;margin-top:6px">` +
    `<span>${label}</span>` +
    `<input id="hub-${id}" type="range" min="0" max="${max}" step="1" value="${value}" style="width:100%">` +
    `<b id="hub-${id}-value" style="text-align:right">${value}</b>` +
    `</label>`
  );
}

function buttonStyle(): Partial<CSSStyleDeclaration> {
  return {
    border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: '7px',
    background: 'rgba(255,255,255,0.08)',
    color: '#eef2f4',
    padding: '5px 8px',
    cursor: 'pointer',
  };
}
