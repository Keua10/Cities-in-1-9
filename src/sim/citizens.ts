import { CHUNK_SIZE, WORLD_SEED } from '../core/constants';
import { chunkIndexOf } from '../core/iso';
import type { World } from '../world/world';
import {
  isAnchor,
  levelOfCode,
  simHash,
  simRandom,
  ZONE_C,
  ZONE_I,
  ZONE_R,
  zoneOfCode,
} from './buildings';
import type { MacroSim } from './macro';
import type { AssignmentTable, DestLink } from './assignment';
import {
  FREIGHT_CURVE,
  RUSH_TO_HOME,
  RUSH_TO_SHOP,
  RUSH_TO_WORK,
  SUPPLY_START,
  SUPPLY_USE_PER_HOUR,
  TICKS_PER_DAY,
} from './simConstants';

export const enum TripPurpose {
  Commute = 0,
  Home = 1,
  Shop = 2,
  Freight = 3,
}

export interface Trip {
  purpose: TripPurpose;
  tier: number;
  fromTx: number;
  fromTy: number;
  toTx: number;
  toTy: number;
}

interface HomeState {
  tx: number;
  ty: number;
  tier: number;
  supply: Uint8Array;
  inTransit: Uint8Array;
  lastHour: number;
  scanCursor: number;
}

interface ReturnReservation {
  homeTx: number;
  homeTy: number;
  slot: number;
  tier: number;
  jobTx: number;
  jobTy: number;
  dueTick: number;
}

interface BoundaryJob {
  homeTx: number;
  homeTy: number;
  tier: number;
  baseSlot: number;
  link: DestLink;
}

interface Business {
  tx: number;
  ty: number;
  tier: number;
  zone: number;
}

export class CitizenPool {
  private homes = new Map<string, HomeState>();
  /** 출근 완료 시 생기는 퇴근 예약. 시민의 저장 상태가 아니라 현재 접속의 통행 예약이다. */
  private returns = new Map<string, ReturnReservation>();
  /** 외부 주거 -> 활성 영역 직장. 사람 객체 대신 배정 링크와 슬롯 범위만 든다. */
  private boundaryJobs: BoundaryJob[] = [];
  private businesses: Business[] = [];
  private cx = 0;
  private cy = 0;
  private radius = 1;
  private boundaryHour = -1;
  private boundaryLinkCursor = 0;
  private boundarySlotCursor = 0;
  private freightHour = -1;
  private freightCursor = 0;

  constructor(
    private world: World,
    private macro: MacroSim,
    private assignment: AssignmentTable,
  ) {}

  setActiveRegion(cx: number, cy: number, radius: number): void {
    if (cx === this.cx && cy === this.cy && radius === this.radius && this.homes.size > 0) return;
    this.cx = cx;
    this.cy = cy;
    this.radius = radius;
    this.boundaryHour = -1;
    this.boundaryLinkCursor = 0;
    this.boundarySlotCursor = 0;
    this.freightHour = -1;
    this.freightCursor = 0;

    const next = new Map<string, HomeState>();
    const businesses: Business[] = [];
    for (const p of this.world.developedParcels()) {
      if (Math.abs(p.cx - cx) > radius || Math.abs(p.cy - cy) > radius || !p.bld) continue;
      const bx = p.cx * CHUNK_SIZE;
      const by = p.cy * CHUNK_SIZE;
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const code = p.bld[ly * CHUNK_SIZE + lx];
          if (!isAnchor(code)) continue;
          const zone = zoneOfCode(code);
          const tier = levelOfCode(code);
          const tx = bx + lx;
          const ty = by + ly;
          if (zone === ZONE_R) {
            const assignment = this.assignment.get(tx, ty);
            const count =
              (assignment?.jobs.reduce((n, link) => n + link.count, 0) ?? 0) +
              (assignment?.unemployed ?? 0);
            const key = `${tx},${ty}`;
            let state = this.homes.get(key);
            if (!state || state.supply.length !== count) {
              state = {
                tx,
                ty,
                tier,
                supply: new Uint8Array(count).fill(SUPPLY_START),
                inTransit: new Uint8Array(count),
                lastHour: -1,
                scanCursor: 0,
              };
            }
            next.set(key, state);
          } else {
            businesses.push({ tx, ty, tier, zone });
          }
        }
      }
    }
    this.homes = next;
    this.businesses = businesses;

    // 카메라 밖으로 빠진 주거의 퇴근 예약은 개인 상태와 함께 버린다.
    for (const [key, reservation] of this.returns) {
      if (!this.homes.has(`${reservation.homeTx},${reservation.homeTy}`)) this.returns.delete(key);
    }
    this.rebuildBoundaryJobs();
  }

  /** 게임 1시간마다 계층별 생필품을 줄인다. */
  consumeSupplies(tier: number): void {
    for (const home of this.homes.values()) {
      if (home.tier === tier) this.consumeHomeHour(home);
    }
  }

  collectTrips(hourOfDay: number, _dtMs: number, budget: number): Trip[] {
    const out: Trip[] = [];
    const absoluteTick = this.macro.day * TICKS_PER_DAY + hourOfDay;

    // 출근을 실제로 완료한 활성 시민의 퇴근 예약을 먼저 처리한다.
    for (const [key, reservation] of this.returns) {
      if (out.length >= budget) break;
      if (reservation.dueTick > absoluteTick) continue;
      const home = this.homes.get(`${reservation.homeTx},${reservation.homeTy}`);
      if (!home) {
        this.returns.delete(key);
        continue;
      }
      if (home.inTransit[reservation.slot]) continue;
      home.inTransit[reservation.slot] = 1;
      out.push({
        purpose: TripPurpose.Home,
        tier: reservation.tier,
        fromTx: reservation.jobTx,
        fromTy: reservation.jobTy,
        toTx: reservation.homeTx,
        toTy: reservation.homeTy,
      });
    }

    for (const home of this.homes.values()) {
      if (out.length >= budget) break;
      if (home.lastHour !== hourOfDay) {
        home.lastHour = hourOfDay;
        home.scanCursor = 0;
        this.consumeHomeHour(home);
      }

      while (home.scanCursor < home.supply.length && out.length < budget) {
        const slot = home.scanCursor++;
        if (home.inTransit[slot]) continue;
        const offset = simRandom(WORLD_SEED, home.tx, home.ty, slot);
        const workHour = weightedHour(RUSH_TO_WORK, offset, 6, 10);
        const job = this.assignment.jobForSlot(home.tx, home.ty, slot);
        if (job && hourOfDay === workHour && !this.returns.has(returnKey(home.tx, home.ty, slot))) {
          home.inTransit[slot] = 1;
          out.push({
            purpose: TripPurpose.Commute,
            tier: home.tier,
            fromTx: home.tx,
            fromTy: home.ty,
            toTx: job.tx,
            toTy: job.ty,
          });
          continue;
        }
        if (home.supply[slot] === 0) {
          const shopOffset = simRandom(WORLD_SEED, home.tx, home.ty, slot ^ this.macro.day);
          const shopHour = weightedHour(RUSH_TO_SHOP, shopOffset, 10, 21);
          if (hourOfDay === shopHour) {
            const shop = this.assignment.shopForSlot(home.tx, home.ty, slot, this.macro.day);
            if (shop) {
              home.inTransit[slot] = 1;
              out.push({
                purpose: TripPurpose.Shop,
                tier: home.tier,
                fromTx: home.tx,
                fromTy: home.ty,
                toTx: shop.tx,
                toTy: shop.ty,
              });
            }
          }
        }
      }
    }

    if (out.length < budget) this.collectBoundary(hourOfDay, budget, out);
    if (out.length < budget) this.collectFreight(hourOfDay, budget, out);
    return out;
  }

  onTripComplete(trip: Trip): void {
    const home = this.homeForTrip(trip);
    if (!home) return; // 외부 시민과 화물은 개인 상태가 없다.
    const slot = this.findTransitSlot(home, trip);
    if (slot < 0) return;
    home.inTransit[slot] = 0;

    if (trip.purpose === TripPurpose.Commute) {
      const offset = simRandom(WORLD_SEED, home.tx, home.ty, slot);
      const returnHour = weightedHour(RUSH_TO_HOME, (offset * 1.73) % 1, 16, 20);
      let dueDay = this.macro.day;
      if (returnHour <= this.macro.hourOfDay) dueDay++;
      this.returns.set(returnKey(home.tx, home.ty, slot), {
        homeTx: home.tx,
        homeTy: home.ty,
        slot,
        tier: home.tier,
        jobTx: trip.toTx,
        jobTy: trip.toTy,
        dueTick: dueDay * TICKS_PER_DAY + returnHour,
      });
    } else if (trip.purpose === TripPurpose.Home) {
      this.returns.delete(returnKey(home.tx, home.ty, slot));
    } else if (trip.purpose === TripPurpose.Shop) {
      home.supply[slot] = 255;
    }
  }

  onTripFailed(trip: Trip): void {
    const home = this.homeForTrip(trip);
    if (!home) return;
    const slot = this.findTransitSlot(home, trip);
    if (slot < 0) return;
    home.inTransit[slot] = 0;
    if (trip.purpose === TripPurpose.Shop) {
      home.supply[slot] = Math.max(home.supply[slot], 64);
    } else if (trip.purpose === TripPurpose.Home) {
      // 경로가 없으면 개인 차량을 계속 재시도하지 않고 화면 밖 이동으로 추상화한다.
      this.returns.delete(returnKey(home.tx, home.ty, slot));
    }
  }

  private rebuildBoundaryJobs(): void {
    const out: BoundaryJob[] = [];
    const slotBase = new Map<string, number>();
    for (const { fromTx, fromTy, link } of this.assignment.allLinks()) {
      const assignment = this.assignment.get(fromTx, fromTy);
      if (!assignment || !assignment.jobs.includes(link)) continue;
      const homeKey = `${fromTx},${fromTy}`;
      const baseSlot = slotBase.get(homeKey) ?? 0;
      slotBase.set(homeKey, baseSlot + link.count);
      if (this.tileInside(fromTx, fromTy) || !this.tileInside(link.tx, link.ty)) continue;
      const tier = this.world.buildingCovering(fromTx, fromTy)?.level ?? 1;
      out.push({ homeTx: fromTx, homeTy: fromTy, tier, baseSlot, link });
    }
    this.boundaryJobs = out;
  }

  private collectBoundary(hour: number, budget: number, out: Trip[]): void {
    if (this.boundaryHour !== hour) {
      this.boundaryHour = hour;
      this.boundaryLinkCursor = 0;
      this.boundarySlotCursor = 0;
    }
    while (this.boundaryLinkCursor < this.boundaryJobs.length && out.length < budget) {
      const flow = this.boundaryJobs[this.boundaryLinkCursor];
      while (this.boundarySlotCursor < flow.link.count && out.length < budget) {
        const slot = flow.baseSlot + this.boundarySlotCursor++;
        const offset = simRandom(WORLD_SEED, flow.homeTx, flow.homeTy, slot);
        const workHour = weightedHour(RUSH_TO_WORK, offset, 6, 10);
        const homeHour = weightedHour(RUSH_TO_HOME, (offset * 1.73) % 1, 16, 20);
        if (hour === workHour) {
          out.push({
            purpose: TripPurpose.Commute,
            tier: flow.tier,
            fromTx: flow.homeTx,
            fromTy: flow.homeTy,
            toTx: flow.link.tx,
            toTy: flow.link.ty,
          });
        } else if (hour === homeHour) {
          out.push({
            purpose: TripPurpose.Home,
            tier: flow.tier,
            fromTx: flow.link.tx,
            fromTy: flow.link.ty,
            toTx: flow.homeTx,
            toTy: flow.homeTy,
          });
        }
      }
      if (this.boundarySlotCursor >= flow.link.count) {
        this.boundaryLinkCursor++;
        this.boundarySlotCursor = 0;
      }
    }
  }

  private consumeHomeHour(home: HomeState): void {
    const use = SUPPLY_USE_PER_HOUR[home.tier - 1] ?? 0;
    for (let i = 0; i < home.supply.length; i++) {
      home.supply[i] = Math.max(0, home.supply[i] - use);
    }
  }

  private homeForTrip(trip: Trip): HomeState | undefined {
    if (trip.purpose === TripPurpose.Commute || trip.purpose === TripPurpose.Shop) {
      return this.homes.get(`${trip.fromTx},${trip.fromTy}`);
    }
    if (trip.purpose === TripPurpose.Home) return this.homes.get(`${trip.toTx},${trip.toTy}`);
    return undefined;
  }

  private findTransitSlot(home: HomeState, trip: Trip): number {
    for (let slot = 0; slot < home.inTransit.length; slot++) {
      if (!home.inTransit[slot]) continue;
      const job = this.assignment.jobForSlot(home.tx, home.ty, slot);
      if (trip.purpose === TripPurpose.Commute && job?.tx === trip.toTx && job.ty === trip.toTy) {
        return slot;
      }
      if (trip.purpose === TripPurpose.Home && job?.tx === trip.fromTx && job.ty === trip.fromTy) {
        return slot;
      }
      if (trip.purpose === TripPurpose.Shop) {
        const shop = this.assignment.shopForSlot(home.tx, home.ty, slot, this.macro.day);
        if (shop?.tx === trip.toTx && shop.ty === trip.toTy) return slot;
      }
    }
    return -1;
  }

  private collectFreight(hour: number, budget: number, out: Trip[]): void {
    if (this.freightHour !== hour) {
      this.freightHour = hour;
      this.freightCursor = 0;
    }
    const industries = this.businesses.filter((b) => b.zone === ZONE_I);
    const destinations = this.businesses.filter((b) => b.zone === ZONE_C || b.zone === ZONE_I);
    if (destinations.length === 0) return;

    while (this.freightCursor < industries.length && out.length < budget) {
      const business = industries[this.freightCursor++];
      const gate = simRandom(WORLD_SEED, business.tx, business.ty, this.macro.tick);
      if (gate > FREIGHT_CURVE[hour] * 0.12) continue;
      const dest =
        destinations[
          simHash(WORLD_SEED, business.tx, business.ty, this.macro.day) % destinations.length
        ];
      if (dest.tx === business.tx && dest.ty === business.ty) continue;
      out.push({
        purpose: TripPurpose.Freight,
        tier: business.tier,
        fromTx: business.tx,
        fromTy: business.ty,
        toTx: dest.tx,
        toTy: dest.ty,
      });
    }
  }

  private tileInside(tx: number, ty: number): boolean {
    return (
      Math.abs(chunkIndexOf(tx) - this.cx) <= this.radius &&
      Math.abs(chunkIndexOf(ty) - this.cy) <= this.radius
    );
  }
}

function returnKey(tx: number, ty: number, slot: number): string {
  return `${tx},${ty},${slot}`;
}

function weightedHour(
  curve: readonly number[],
  random: number,
  start: number,
  end: number,
): number {
  let total = 0;
  for (let hour = start; hour <= end; hour++) total += Math.max(0, curve[hour] ?? 0);
  if (total <= 0) return start;
  let target = random * total;
  for (let hour = start; hour <= end; hour++) {
    target -= Math.max(0, curve[hour] ?? 0);
    if (target <= 0) return hour;
  }
  return end;
}
