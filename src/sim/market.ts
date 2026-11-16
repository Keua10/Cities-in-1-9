import {
  MARKET_MAX_LOT,
  MARKET_REF_STOCK,
  marketPrice,
  RESOURCE_NAMES,
  RESOURCES,
  tradeTotal,
  type ResourceId,
} from './config/resources';

/**
 * 시장 거래 계산 (Firebase 없음). net/market.ts 가 공용 문서와 함께 쓰고, 둘러보기와
 * 점검 도구는 이것만 쓴다.
 */

export type MarketStock = Record<ResourceId, number>;

export interface TradeResult {
  ok: boolean;
  /** 실제로 사고판 양(사면 +, 팔면 -). */
  qty: number;
  /** 낸 돈(+) 또는 받은 돈(-), 만 원. */
  cost: number;
  message: string;
}

export function initialMarketStock(): MarketStock {
  return { iron: MARKET_REF_STOCK.iron, coal: MARKET_REF_STOCK.coal, oil: MARKET_REF_STOCK.oil };
}

export function normalizeMarketStock(raw: unknown): MarketStock {
  const out = initialMarketStock();
  if (raw && typeof raw === 'object')
    for (const r of RESOURCES) {
      const v = Number((raw as Record<string, unknown>)[r]);
      if (Number.isFinite(v) && v >= 0) out[r] = Math.floor(v);
    }
  return out;
}

/**
 * 시장 재고 stock 에서 qty(+ 사기, - 팔기)를 거래하면 어떻게 되는가.
 * money = 가진 돈, have = 가진 자원, room = 더 쌓을 수 있는 양.
 */
export function decideTrade(
  r: ResourceId,
  stock: number,
  qty: number,
  money: number,
  have: number,
  room: number,
): TradeResult {
  qty = Math.trunc(qty);
  if (Math.abs(qty) > MARKET_MAX_LOT) qty = Math.sign(qty) * MARKET_MAX_LOT;
  const name = RESOURCE_NAMES[r];
  if (qty === 0) return { ok: false, qty: 0, cost: 0, message: '' };
  if (qty > 0) {
    let q = Math.min(qty, stock, Math.floor(room));
    if (q <= 0)
      return {
        ok: false,
        qty: 0,
        cost: 0,
        message: stock <= 0 ? `시장에 ${name} 재고가 없습니다` : '창고가 가득 찼습니다',
      };
    // 돈이 모자라면 살 수 있는 만큼만.
    while (q > 0 && tradeTotal(r, stock, q) > money) q = Math.floor(q * 0.8);
    if (q <= 0) return { ok: false, qty: 0, cost: 0, message: '돈이 모자랍니다' };
    return { ok: true, qty: q, cost: tradeTotal(r, stock, q), message: '' };
  }
  const q = -Math.min(-qty, Math.floor(have));
  if (q >= 0) return { ok: false, qty: 0, cost: 0, message: `팔 ${name}이 없습니다` };
  return { ok: true, qty: q, cost: -tradeTotal(r, stock, q), message: '' };
}

/** 이 기기 안의 시장(둘러보기·점검). */
export class LocalMarket {
  stock: MarketStock = initialMarketStock();
  online = false;
  revision = 0;

  price(r: ResourceId): number {
    return marketPrice(r, this.stock[r]);
  }

  async trade(
    r: ResourceId,
    qty: number,
    money: number,
    have: number,
    room: number,
  ): Promise<TradeResult> {
    const res = decideTrade(r, this.stock[r], qty, money, have, room);
    if (res.ok) {
      this.stock[r] = Math.max(0, this.stock[r] - res.qty);
      this.revision++;
    }
    return res;
  }
}
