import { CHUNK_SIZE, WORLD_SEED } from '../core/constants';
import { Build } from '../world/build';
import type { World } from '../world/world';
import { capacityOf, isAnchor, levelOfCode, simHash, ZONE_C, ZONE_R, zoneOfCode } from './buildings';
import type { CityStats } from './macro';
import { edgeNeighbors, type RoadField } from './roadGraph';
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
    for (const home of homes) {
      const filled=home.capacity;
      const out:ParcelAssignment={jobs:[],shops:[],unemployed:filled};
      let left=filled;
      const distances=roadDistances(world,home.roadTx,home.roadTy,COMMUTE_RANGE_BY_TIER[home.level-1]);
      const candidates=jobs.map(j=>({j,dist:distances.get(key(j.roadTx,j.roadTy))??-1}))
        .filter(x=>x.dist>=0 && x.j.remaining>0)
        .sort((a,b)=>jobScore(home.level,b.j.level,b.dist)-jobScore(home.level,a.j.level,a.dist) || coordSort(a.j,b.j));
      for(const {j,dist} of candidates){ if(left<=0)break; const take=Math.min(left,j.remaining); if(take<=0)continue; pushLink(out.jobs,j,take,dist); j.remaining-=take; left-=take; }
      out.unemployed=left;
      const shopMax=SHOP_RANGE_BY_TIER[home.level-1];
      const shopCandidates=shops.map(s=>({s,dist:distances.get(key(s.roadTx,s.roadTy))??-1}))
        .filter(x=>x.dist>=0 && x.dist<=shopMax)
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
function coordSort(a:{tx:number;ty:number},b:{tx:number;ty:number}){return a.ty-b.ty||a.tx-b.tx;}
function pushLink(out:DestLink[],b:Building,count:number,dist:number){if(count>0)out.push({tx:b.tx,ty:b.ty,count,level:b.level,zone:b.zone,dist});}
function jobScore(homeLevel:number,jobLevel:number,dist:number){return JOB_FIT[homeLevel-1][jobLevel-1]*10000-dist;}
function shopScore(homeLevel:number,shopLevel:number,dist:number){const levelBias=homeLevel===3?shopLevel*1800:shopLevel*500; const distanceWeight=homeLevel===3?15:40; return levelBias-dist*distanceWeight;}
function firstRoad(world:World,tx:number,ty:number,span:number):[number,number]|null{for(const [x,y] of edgeNeighbors(tx,ty,span))if(world.getBuild(x,y)===Build.Road)return[x,y];return null;}
function roadDistances(world:World,sx:number,sy:number,max:number):Map<string,number>{
  const out=new Map<string,number>();
  if(world.getBuild(sx,sy)!==Build.Road)return out;
  const qx=[sx],qy=[sy],qd=[0];let h=0;out.set(key(sx,sy),0);
  const dirs=[[1,0],[0,1],[-1,0],[0,-1]] as const;
  while(h<qx.length){const x=qx[h],y=qy[h],d=qd[h++];if(d>=max)continue;for(const [dx,dy] of dirs){const nx=x+dx,ny=y+dy,k=key(nx,ny);if(out.has(k)||world.getBuild(nx,ny)!==Build.Road)continue;out.set(k,d+1);qx.push(nx);qy.push(ny);qd.push(d+1);}}
  return out;
}
