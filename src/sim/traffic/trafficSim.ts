import { MAX_ACTIVE_VEHICLES, SIM_RADIUS_CHUNKS } from '../../core/constants';
import { chunkIndexOf } from '../../core/iso';
import { Build, DIRS, roadMask } from '../../world/build';
import type { World } from '../../world/world';
import type { AssignmentTable } from '../assignment';
import { CitizenPool, TripPurpose, type Trip } from '../citizens';
import type { CongestionMap } from '../congestion';
import type { MacroSim } from '../macro';
import { edgeNeighbors } from '../roadGraph';
import { ACCEL_TILES_PER_SEC2, DECEL_TILES_PER_SEC2, DESIRED_GAP_TILES, MAX_SPAWNS_PER_SEC, MIN_GAP_TILES, REROUTE_LOOKAHEAD, REROUTE_THRESHOLD, ROUTE_BUDGET_PER_FRAME, TRUCK_SPEED_MUL, VEHICLE_SPEED_TILES_PER_SEC } from '../simConstants';
import { daytimeAt, type DaytimeSnapshot } from '../time';
import { canEnter, hasSignal } from './signals';
import { Router, type Route } from './router';
import { VehicleKind, type Vehicle } from './vehicles';

export class TrafficSim {
  private router:Router; private citizens:CitizenPool; private vehicles:Vehicle[]=[]; private trips=new Map<Vehicle,Trip>(); private byChunk=new Map<string,Vehicle[]>();
  private activeCx=0;private activeCy=0;private initialized=false;private timeMs=0;private sampleMs=0;private daytime:DaytimeSnapshot=daytimeAt(0,0);private spawnTokens=0;private spawnWindowMs=0;private spawnedInWindow=0;private readySpawns:{trip:Trip;route:Route}[]=[];private generation=0;private lastMacroTick=-1;
  constructor(private world:World,private macro:MacroSim,private congestion:CongestionMap,assignment:AssignmentTable){this.router=new Router(world,congestion);this.citizens=new CitizenPool(world,assignment);}
  setActiveChunk(cx:number,cy:number):void{if(this.initialized&&cx===this.activeCx&&cy===this.activeCy)return;for(const pending of this.readySpawns)this.citizens.onTripFailed(pending.trip);this.readySpawns=[];this.initialized=true;this.activeCx=cx;this.activeCy=cy;this.generation++;this.citizens.setActiveRegion(cx,cy,SIM_RADIUS_CHUNKS);this.congestion.setActiveRegion(cx,cy,SIM_RADIUS_CHUNKS);const kept:Vehicle[]=[];for(const v of this.vehicles){if(this.vehicleInside(v))kept.push(v);else this.failVehicle(v);}this.vehicles=kept;this.rebuildChunks();}
  update(dtMs:number,wallNowMs:number=Date.now()):void{
    if(!this.initialized)return;this.timeMs+=dtMs;this.sampleMs+=dtMs;this.spawnWindowMs+=dtMs;if(this.spawnWindowMs>=1000){this.spawnWindowMs%=1000;this.spawnedInWindow=0;}this.spawnTokens=Math.min(MAX_SPAWNS_PER_SEC,this.spawnTokens+dtMs*MAX_SPAWNS_PER_SEC/1000);
    this.router.update(ROUTE_BUDGET_PER_FRAME);
    if (this.macro.tick !== this.lastMacroTick) { this.lastMacroTick = this.macro.tick; this.congestion.decayOutside(this.world, this.activeCx, this.activeCy, SIM_RADIUS_CHUNKS); }
    this.retryReadySpawns();
    const room=Math.max(0,MAX_ACTIVE_VEHICLES-this.vehicles.length);const budget=Math.min(room,Math.floor(this.spawnTokens));
    const lifeDelta=Math.min(dtMs,250);this.daytime=daytimeAt(wallNowMs,this.macro.day);
    const trips=this.citizens.collectTrips(this.daytime,lifeDelta,budget);for(const trip of trips){if(this.spawnTokens<1)break;this.spawnTokens-=1;this.queueTrip(trip);}
    this.moveVehicles(dtMs/1000);
    for(const v of this.vehicles){const [tx,ty]=tileAt(v);this.congestion.sample(tx,ty);}
    this.congestion.finishSampleFrame();
    if(this.sampleMs>=1000){this.sampleMs%=1000;this.congestion.commitSamples(this.world);this.router.invalidateCache();}
    if(this.vehicles.length>MAX_ACTIVE_VEHICLES){this.vehicles.sort((a,b)=>dist2(b,this.activeCx,this.activeCy)-dist2(a,this.activeCx,this.activeCy));while(this.vehicles.length>MAX_ACTIVE_VEHICLES){const v=this.vehicles.shift();if(v)this.failVehicle(v);}}
    this.rebuildChunks();
  }
  vehiclesInChunk(cx:number,cy:number):readonly Vehicle[]{return this.byChunk.get(`${cx},${cy}`)??EMPTY;}
  get activeCount():number{return this.vehicles.length;}
  /** 출퇴근과 향후 밤낮 렌더링이 공유하는 실제시간 기반 daytime. */
  get daytimeState():DaytimeSnapshot{return this.daytime;}
  private queueTrip(trip:Trip){const sourceInfo=this.world.buildingCovering(trip.fromTx,trip.fromTy),start=entryRoad(this.world,trip.fromTx,trip.fromTy,sourceInfo?.span??1),destInfo=this.world.buildingCovering(trip.toTx,trip.toTy),dest=entryRoad(this.world,trip.toTx,trip.toTy,destInfo?.span??1);if(!start||!dest){this.citizens.onTripFailed(trip);return;}const gen=this.generation;this.router.request(start[0],start[1],dest[0],dest[1],trip.tier,(route)=>{if(gen!==this.generation){this.citizens.onTripFailed(trip);return;}if(!route){this.citizens.onTripFailed(trip);return;}if(!this.spawnRoute(trip,route))this.readySpawns.push({trip,route});});}
  private spawnRoute(trip:Trip,route:Route):boolean{if(this.vehicles.length>=MAX_ACTIVE_VEHICLES||this.spawnedInWindow>=MAX_SPAWNS_PER_SEC)return false;let startIndex=0;if(!this.tileInside(route.tiles[0],route.tiles[1])){startIndex=-1;for(let i=0;i<route.tiles.length;i+=2){if(this.tileInside(route.tiles[i],route.tiles[i+1])){startIndex=i/2;break;}}if(startIndex<0){this.citizens.onTripFailed(trip);return true;}}
    const sx=route.tiles[startIndex*2],sy=route.tiles[startIndex*2+1];const sliced=startIndex===0?route:this.router.sliceRoute(route,startIndex);const dir=sliced.tiles.length>=4?dirBetween(sliced.tiles[0],sliced.tiles[1],sliced.tiles[2],sliced.tiles[3]):0;if(this.spawnBlocked(sx,sy,dir))return false;const kind=trip.purpose===TripPurpose.Freight?VehicleKind.Truck:VehicleKind.Car;const vehicle:Vehicle={kind,tier:trip.tier,purpose:trip.purpose,route:sliced,routeIdx:0,tileT:0,lane:0,speed:0,dir,destTx:trip.toTx,destTy:trip.toTy};this.vehicles.push(vehicle);this.trips.set(vehicle,trip);this.spawnedInWindow++;return true;}
  private retryReadySpawns(){if(!this.readySpawns.length)return;const left:{trip:Trip;route:Route}[]=[];for(const p of this.readySpawns){if(this.vehicles.length>=MAX_ACTIVE_VEHICLES||!this.spawnRoute(p.trip,p.route))left.push(p);}this.readySpawns=left.slice(0,MAX_ACTIVE_VEHICLES);}
  private spawnBlocked(tx:number,ty:number,dir:number){for(const v of this.vehicles){const [x,y]=tileAt(v);if(x===tx&&y===ty&&v.dir===dir)return true;}return false;}
  private moveVehicles(dt:number){const occupancy=new Map<string,Vehicle[]>();for(const v of this.vehicles){const [x,y]=tileAt(v),k=laneKey(x,y,v.dir);let a=occupancy.get(k);if(!a){a=[];occupancy.set(k,a);}a.push(v);}for(const a of occupancy.values())a.sort((x,y)=>y.tileT-x.tileT);
    const remove=new Set<Vehicle>();for(const v of this.vehicles){const points=v.route.tiles.length/2;if(v.routeIdx>=points-1){this.completeVehicle(v);remove.add(v);continue;}const nextX=v.route.tiles[(v.routeIdx+1)*2],nextY=v.route.tiles[(v.routeIdx+1)*2+1];let target=VEHICLE_SPEED_TILES_PER_SEC*(v.kind===VehicleKind.Truck?TRUCK_SPEED_MUL:1);const gap=this.gapAhead(v,occupancy,nextX,nextY);if(gap<=MIN_GAP_TILES)target=0;else if(gap<DESIRED_GAP_TILES)target*=Math.max(0,(gap-MIN_GAP_TILES)/(DESIRED_GAP_TILES-MIN_GAP_TILES));if(hasSignal(this.world,nextX,nextY)&&!canEnter(nextX,nextY,v.dir,this.timeMs)&&v.tileT>.72)target=0;
      const accel=target>v.speed?ACCEL_TILES_PER_SEC2:DECEL_TILES_PER_SEC2;v.speed=approach(v.speed,target,accel*dt);v.tileT+=v.speed*dt;
      while(v.tileT>=1&&v.routeIdx<points-1){v.tileT-=1;v.routeIdx++;if(v.routeIdx>=points-1)break;const x=v.route.tiles[v.routeIdx*2],y=v.route.tiles[v.routeIdx*2+1],nx=v.route.tiles[(v.routeIdx+1)*2],ny=v.route.tiles[(v.routeIdx+1)*2+1];v.dir=dirBetween(x,y,nx,ny);if(!this.tileInside(x,y)){this.completeVehicle(v);remove.add(v);break;}if(pop4(roadMask(this.world,x,y))>=3&&this.shouldReroute(v)){this.reroute(v);break;}}
      if(v.routeIdx>=points-1&&!remove.has(v)){this.completeVehicle(v);remove.add(v);}
    }
    if(remove.size)this.vehicles=this.vehicles.filter(v=>!remove.has(v));
  }
  private gapAhead(v:Vehicle,occ:Map<string,Vehicle[]>,nextX:number,nextY:number){const [x,y]=tileAt(v);let best=Infinity;for(const o of occ.get(laneKey(x,y,v.dir))??[]){if(o===v)continue;const d=o.tileT-v.tileT;if(d>0)best=Math.min(best,d);}for(const o of occ.get(laneKey(nextX,nextY,v.dir))??[]){best=Math.min(best,1-v.tileT+o.tileT);}return best;}
  private shouldReroute(v:Vehicle){let cur=0,n=0;const start=v.routeIdx+1;for(let i=start;i<Math.min(v.route.tiles.length/2,start+REROUTE_LOOKAHEAD);i++){cur+=this.congestion.at(v.route.tiles[i*2],v.route.tiles[i*2+1]);n++;}const planned=this.router.plannedCongestion(v.route,start,n);return n>0&&cur-planned>=REROUTE_THRESHOLD;}
  private reroute(v:Vehicle){const [sx,sy]=tileAt(v),destInfo=this.world.buildingCovering(v.destTx,v.destTy),dest=entryRoad(this.world,v.destTx,v.destTy,destInfo?.span??1);if(!dest)return;this.router.request(sx,sy,dest[0],dest[1],v.tier,(route)=>{if(route){v.route=route;v.routeIdx=0;v.tileT=0;if(route.tiles.length>=4)v.dir=dirBetween(route.tiles[0],route.tiles[1],route.tiles[2],route.tiles[3]);}});}
  private completeVehicle(v:Vehicle){const trip=this.trips.get(v);if(trip)this.citizens.onTripComplete(trip);this.trips.delete(v);}
  private failVehicle(v:Vehicle){const trip=this.trips.get(v);if(trip)this.citizens.onTripFailed(trip);this.trips.delete(v);}
  private tileInside(tx:number,ty:number){const cx=chunkIndexOf(tx),cy=chunkIndexOf(ty);return Math.abs(cx-this.activeCx)<=SIM_RADIUS_CHUNKS&&Math.abs(cy-this.activeCy)<=SIM_RADIUS_CHUNKS;}
  private vehicleInside(v:Vehicle){const [x,y]=tileAt(v);return this.tileInside(x,y);}
  private rebuildChunks(){this.byChunk.clear();for(const v of this.vehicles){const [x,y]=tileAt(v),k=`${chunkIndexOf(x)},${chunkIndexOf(y)}`;let a=this.byChunk.get(k);if(!a){a=[];this.byChunk.set(k,a);}a.push(v);}}
}
const EMPTY:readonly Vehicle[]=[];
function entryRoad(world:World,tx:number,ty:number,span:number):[number,number]|null{for(const p of edgeNeighbors(tx,ty,span))if(world.getBuild(p[0],p[1])===Build.Road)return p;return null;}
function tileAt(v:Vehicle):[number,number]{return[v.route.tiles[v.routeIdx*2],v.route.tiles[v.routeIdx*2+1]];}
function dirBetween(x:number,y:number,nx:number,ny:number){for(let i=0;i<DIRS.length;i++)if(x+DIRS[i][0]===nx&&y+DIRS[i][1]===ny)return i;return 0;}
function pop4(m:number){return(m&1)+((m>>1)&1)+((m>>2)&1)+((m>>3)&1);}
function approach(v:number,t:number,d:number){return v<t?Math.min(t,v+d):Math.max(t,v-d);}
function dist2(v:Vehicle,cx:number,cy:number){const [x,y]=tileAt(v),dx=chunkIndexOf(x)-cx,dy=chunkIndexOf(y)-cy;return dx*dx+dy*dy;}


function laneKey(tx:number,ty:number,dir:number){return `${tx},${ty},${dir}`;}
