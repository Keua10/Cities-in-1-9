import { Mesh, MeshGeometry } from 'pixi.js';
import { MAX_ACTIVE_VEHICLES, TILE_W, WORLD_SEED } from '../core/constants';
import { tileToWorldX, tileToWorldY } from '../core/iso';
import { simHash } from '../sim/buildings';
import type { Vehicle } from '../sim/traffic/vehicles';
import type { World } from '../world/world';
import { VEHICLE_CELL, VEHICLE_VARIANTS, type VehicleAtlas } from './vehicleAtlas';
export class VehicleMesh{
  readonly mesh:Mesh;private geometry:MeshGeometry;private positions:Float32Array;private uvs:Float32Array;private sorted:Vehicle[]=[];
  constructor(private world:World,private atlas:VehicleAtlas){const n=MAX_ACTIVE_VEHICLES;this.positions=new Float32Array(n*8);this.uvs=new Float32Array(n*8);const indices=new Uint32Array(n*6);for(let q=0;q<n;q++){const v=q*4,o=q*6;indices[o]=v;indices[o+1]=v+1;indices[o+2]=v+2;indices[o+3]=v;indices[o+4]=v+2;indices[o+5]=v+3;}this.geometry=new MeshGeometry({positions:this.positions,uvs:this.uvs,indices});this.mesh=new Mesh({geometry:this.geometry,texture:atlas.texture});}
  update(vehicles:readonly Vehicle[]){this.sorted.length=0;for(const v of vehicles)this.sorted.push(v);this.sorted.sort((a,b)=>depth(a)-depth(b));let q=0;for(const v of this.sorted){if(q>=MAX_ACTIVE_VEHICLES)break;const i=v.routeIdx*2,tx=v.route.tiles[i],ty=v.route.tiles[i+1];const ni=Math.min(i+2,v.route.tiles.length-2),nx=v.route.tiles[ni],ny=v.route.tiles[ni+1];const t=v.tileT;let wx=tileToWorldX(tx,ty)+(tileToWorldX(nx,ny)-tileToWorldX(tx,ty))*t;let wy=tileToWorldY(tx,ty,this.world.sampleHeight(tx,ty))+(tileToWorldY(nx,ny,this.world.sampleHeight(nx,ny))-tileToWorldY(tx,ty,this.world.sampleHeight(tx,ty)))*t;const lane=(v.lane?1:-1)*3;wx+=v.dir===0||v.dir===2?lane:-lane;wy+=v.dir===1||v.dir===3?lane*.5:-lane*.5;const half=VEHICLE_CELL/2,x0=wx-half,x1=wx+half,y1=wy,y0=wy-VEHICLE_CELL;write(this.positions,q,[x0,y0,x1,y0,x1,y1,x0,y1]);const variant=simHash(WORLD_SEED,v.destTx,v.destTy,v.tier)%VEHICLE_VARIANTS;const [u0,v0,u1,v1]=this.atlas.uv(v.kind,v.dir,variant);write(this.uvs,q,[u0,v0,u1,v0,u1,v1,u0,v1]);q++;}for(;q<MAX_ACTIVE_VEHICLES;q++){write(this.positions,q,[0,0,0,0,0,0,0,0]);write(this.uvs,q,[0,0,0,0,0,0,0,0]);}this.geometry.getBuffer('aPosition').update();this.geometry.getBuffer('aUV').update();}
  destroy(){this.mesh.destroy();try{this.geometry.destroy(true);}catch{}}
}
function write(a:Float32Array,q:number,v:number[]){let p=q*8;for(let i=0;i<8;i++)a[p+i]=v[i];}
function depth(v:Vehicle){const i=v.routeIdx*2;return v.route.tiles[i]+v.route.tiles[i+1]+v.tileT;}
export const VEHICLE_PIXEL_DENSITY_CHECK=TILE_W===64;
