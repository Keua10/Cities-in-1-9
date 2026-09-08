import { CHUNK_SIZE, WORLD_SEED } from '../core/constants';
import { Build } from '../world/build';
import type { World } from '../world/world';
import { capacityOf, isAnchor, levelOfCode, simHash, ZONE_C, ZONE_R, zoneOfCode } from './buildings';
import type { CityStats } from './macro';
import { edgeNeighbors, roadDistancesFrom, tileKey, type RoadField } from './roadGraph';
import { COMMUTE_RANGE_BY_TIER, JOB_FIT, SHOP_LINKS_MAX, SHOP_RANGE_BY_TIER } from './simConstants';

export interface DestLink { tx: number; ty: number; count: number; level: number; zone: number; dist: number; }
export interface ParcelAssignment { jobs: DestLink[]; shops: DestLink[]; unemployed: number; }
interface Building { tx:number; ty:number; level:number; zone:number; capacity:number; remaining:number; roadTx:number; roadTy:number; }

export class AssignmentTable {
  private table = new Map<string, ParcelAssignment>();

  rebuild(world: World, field: RoadField, stats: CityStats): void {
    void field;
    this.table.clear();
    const jobs: Building[] = [];
    const shops: Building[] = [];
    const homes: Building[] = [];
    for (const p of world.developedParcels()) {
      if (!p.bld) continue;
      const bx=p.cx*CHUNK_SIZE, by=p.cy*CHUNK_SIZE;
      for (let ly=0;ly<CHUNK_SIZE;ly++) for(let lx=0;lx<CHUNK_SIZE;lx++) {
        const code=p.bld[ly*CHUNK_SIZE+lx]; if(!isAnchor(code)) continue;
        const zone=zoneOfCode(code), level=levelOfCode(code), tx=bx+lx, ty=by+ly;
        const road=firstRoad(world,tx,ty,level); if(!road) continue;
        const tierStats=stats.tiers[zone]?.[level-1];
        const fillRatio=tierStats && tierStats.capacity>0 ? Math.max(0,Math.min(1,tierStats.filled/tierStats.capacity)) : 0;
        const cap=Math.round(capacityOf(zone,level)*fillRatio);
        const b:Building={tx,ty,level,zone,capacity:cap,remaining:cap,roadTx:road[0],roadTy:road[1]};
        if(zone===ZONE_R) homes.push(b); else { jobs.push(b); if(zone===ZONE_C) shops.push(b); }
      }
    }
    homes.sort(coordSort); jobs.sort(coordSort); shops.sort(coordSort);
    // 같은 진입 도로를 쓰는 집이 줄줄이 붙어 있다(한 골목의 집들). 집집마다
    // BFS 를 새로 돌리는 대신 최근 것 몇 개만 들고 있으면 절반 넘게 재사용된다.
    // 도시 전체를 캐시하면 맵 수백 개 x 수천 칸이라 메모리가 터진다.
    const cache=new Map<number,Map<number,number>>();
    for (const home of homes) {
      const filled=home.capacity;
      const out:ParcelAssignment={jobs:[],shops:[],unemployed:filled};
      let left=filled;
      const commuteMax=COMMUTE_RANGE_BY_TIER[home.level-1];
      const shopMax=SHOP_RANGE_BY_TIER[home.level-1];
      const distances=distanceFrom(world,home.roadTx,home.roadTy,Math.max(commuteMax,shopMax),cache);
      // 반경 밖 직장은 **객체를 만들기 전에** 걸러낸다. 예전에는 집집마다
      // 도시의 모든 직장을 map 으로 한 번 복사한 뒤 걸렀는데, 큰 도시에서는
      // 그 임시 객체가 수백만 개가 되어 하루치 재계산이 눈에 띄게 멈췄다.
      const candidates:{j:Building;dist:number}[]=[];
      for(const j of jobs){
        if(j.remaining<=0)continue;
        const d=distances.get(tileKey(j.roadTx,j.roadTy));
        if(d===undefined||d>commuteMax)continue;
        candidates.push({j,dist:d});
      }
      candidates.sort((a,b)=>jobScore(home.level,b.j.level,b.dist)-jobScore(home.level,a.j.level,a.dist) || coordSort(a.j,b.j));
      for(const {j,dist} of candidates){ if(left<=0)break; const take=Math.min(left,j.remaining); if(take<=0)continue; pushLink(out.jobs,j,take,dist); j.remaining-=take; left-=take; }
      out.unemployed=left;
      const shopPool:{s:Building;dist:number}[]=[];
      for(const s of shops){
        const d=distances.get(tileKey(s.roadTx,s.roadTy));
        if(d===undefined||d>shopMax)continue;
        shopPool.push({s,dist:d});
      }
      const shopCandidates=shopPool
        .sort((a,b)=>shopScore(home.level,b.s.level,b.dist)-shopScore(home.level,a.s.level,a.dist) || coordSort(a.s,b.s))
        .slice(0,SHOP_LINKS_MAX);
      if(shopCandidates.length && filled>0){
        const base=Math.floor(filled/shopCandidates.length), rem=filled%shopCandidates.length;
        shopCandidates.forEach(({s,dist},i)=>pushLink(out.shops,s,base+(i<rem?1:0),dist));
      }
      this.table.set(key(home.tx,home.ty),out);
    }
  }
  get(anchorTx:number,anchorTy:number):ParcelAssignment|undefined { return this.table.get(key(anchorTx,anchorTy)); }
  jobForSlot(anchorTx:number,anchorTy:number,slot:number):DestLink|null {
    const a=this.get(anchorTx,anchorTy); if(!a||slot<0)return null; let n=slot; for(const l of a.jobs){if(n<l.count)return l;n-=l.count;} return null;
  }
  shopForSlot(anchorTx:number,anchorTy:number,slot:number,day:number):DestLink|null {
    const a=this.get(anchorTx,anchorTy); if(!a?.shops.length)return null; return a.shops[simHash(WORLD_SEED,anchorTx,anchorTy,slot^day)%a.shops.length];
  }
  *allLinks():Generator<{fromTx:number;fromTy:number;link:DestLink}>{ for(const [k,a] of this.table){const [x,y]=k.split(',').map(Number); for(const link of a.jobs) yield {fromTx:x,fromTy:y,link}; for(const link of a.shops) yield {fromTx:x,fromTy:y,link};} }
}
function key(x:number,y:number){return `${x},${y}`;}
/** 진입 도로 기준 거리장. 최근 것만 들고 있는 작은 캐시(FIFO). */
const DISTANCE_CACHE_MAX=24;
function distanceFrom(world:World,x:number,y:number,max:number,cache:Map<number,Map<number,number>>):Map<number,number>{
  const k=tileKey(x,y);
  const hit=cache.get(k);
  if(hit)return hit;
  const made=roadDistancesFrom(world,x,y,max);
  if(cache.size>=DISTANCE_CACHE_MAX){
    const oldest=cache.keys().next();
    if(!oldest.done)cache.delete(oldest.value);
  }
  cache.set(k,made);
  return made;
}
function coordSort(a:{tx:number;ty:number},b:{tx:number;ty:number}){return a.ty-b.ty||a.tx-b.tx;}
function pushLink(out:DestLink[],b:Building,count:number,dist:number){if(count>0)out.push({tx:b.tx,ty:b.ty,count,level:b.level,zone:b.zone,dist});}
function jobScore(homeLevel:number,jobLevel:number,dist:number){return JOB_FIT[homeLevel-1][jobLevel-1]*10000-dist;}
function shopScore(homeLevel:number,shopLevel:number,dist:number){const levelBias=homeLevel===3?shopLevel*1800:shopLevel*500; const distanceWeight=homeLevel===3?15:40; return levelBias-dist*distanceWeight;}
function firstRoad(world:World,tx:number,ty:number,span:number):[number,number]|null{for(const [x,y] of edgeNeighbors(tx,ty,span))if(world.getBuild(x,y)===Build.Road)return[x,y];return null;}
