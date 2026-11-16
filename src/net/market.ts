import { doc, onSnapshot, runTransaction, type Unsubscribe } from 'firebase/firestore';
import type { ResourceId } from '../sim/config/resources';
import {
  decideTrade,
  initialMarketStock,
  LocalMarket,
  normalizeMarketStock,
  type TradeResult,
} from '../sim/market';
import { getFirebase } from './firebase';

/**
 * 도시 간 공용 자원 시장 (군사 2단계).
 *
 * 문서 하나(market/global)에 자원별 **시장 재고**만 있다. 판 도시의 자원이 재고로
 * 쌓이고, 산 도시는 재고에서 가져간다. 그래서 많이 캐서 파는 도시가 수출국이 되고,
 * 모두가 사 가는 자원은 재고가 줄어 비싸진다. 값은 재고로만 정해진다(config/resources.ts).
 *
 * 돈과 자원은 각자 도시 저장(macro)에 있다. 시장 문서는 재고만 트랜잭션으로 고친다.
 * 둘러보기(오프라인)에서는 이 기기 안의 가상 시장(LocalMarket)과 똑같이 움직인다.
 */
export class Market extends LocalMarket {
  private unsubscribe: Unsubscribe | null = null;

  /** 로그인한 학생이면 공용 시장 문서를 구독한다. */
  connect(online: boolean): void {
    const fb = getFirebase();
    if (!online || !fb) return;
    this.online = true;
    this.unsubscribe = onSnapshot(
      doc(fb.db, 'market', 'global'),
      (snap) => {
        if (snap.exists()) {
          this.stock = normalizeMarketStock(snap.data());
          this.revision++;
        }
      },
      (err) => console.warn('시장 구독 실패', err),
    );
  }

  disconnect(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  override async trade(
    r: ResourceId,
    qty: number,
    money: number,
    have: number,
    room: number,
  ): Promise<TradeResult> {
    const fb = getFirebase();
    if (!this.online || !fb) return super.trade(r, qty, money, have, room);
    try {
      const ref = doc(fb.db, 'market', 'global');
      return await runTransaction(fb.db, async (tx) => {
        const snap = await tx.get(ref);
        const stock = snap.exists() ? normalizeMarketStock(snap.data()) : initialMarketStock();
        const out = decideTrade(r, stock[r], qty, money, have, room);
        if (!out.ok) return out;
        const next = { ...stock, [r]: Math.max(0, stock[r] - out.qty) };
        if (snap.exists()) tx.update(ref, { [r]: next[r] });
        else tx.set(ref, next);
        return out;
      });
    } catch (err) {
      console.warn('거래 실패', err);
      return { ok: false, qty: 0, cost: 0, message: '시장에 연결하지 못했습니다 · 잠시 뒤 다시' };
    }
  }
}
