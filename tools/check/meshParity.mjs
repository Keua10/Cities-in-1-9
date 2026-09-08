import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { resolve, relative } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Compare the real renderer buffers against the pre-refactor implementation.
// Pin the reference so this remains useful after committing the refactor.
const baseline = 'c9cda6b';
const stub = `
export class Mesh { constructor(options) { Object.assign(this, options); } destroy() {} }
export class MeshGeometry {
  constructor(options) { Object.assign(this, options); }
  getBuffer() { return { update() {} }; } destroy() {}
}
export class Texture {} export class Graphics {} export class Container {}
`;
const entry = `
import { BuildingMesh } from './src/render/buildingMesh';
import { FacilityMesh } from './src/render/facilityMesh';
import { VehicleMesh } from './src/render/vehicleMesh';
import { CHUNK_SIZE } from './src/core/constants';
const atlas = {texture:{}, uv:(...args)=>[args.reduce((a,b)=>a+b,0)/64,.125,.75,.875]};
const height = (x,y)=>(x+y)%4;
const result=[];
function capture(mesh) {
  const g=mesh.mesh.geometry;
  result.push([mesh.count, [...g.positions], [...g.uvs], [...g.indices]]);
}
for (const cx of [-2,0,3]) for (const populated of [false,true]) {
  const bld=new Uint8Array(CHUNK_SIZE*CHUNK_SIZE).fill(255);
  if(populated) for(let i=0;i<16;i++) bld[i*4]=i;
  const p={cx,cy:1,bld,bldRevision:4};
  capture(new BuildingMesh(p,atlas,height)); capture(new FacilityMesh(p,atlas,height));
}
const vehicles = new VehicleMesh({sampleHeight:height, sampleBuild:()=>0},atlas);
const route={tiles:new Int32Array([0,0,1,0,2,0,2,1,2,2])};
for(const count of [0,1,8,3,0]) {
  vehicles.update(Array.from({length:count},(_,i)=>({route,routeIdx:i%4,tileT:(i%5)/5,destTx:i,destTy:2,tier:i%3,kind:i%2})));
  capture(vehicles);
}
export default result;
`;
async function snapshot(original) {
  const bundled = await build({ stdin:{contents:entry,resolveDir:resolve('.')},bundle:true,
    platform:'node',format:'esm',write:false,plugins:[{name:'renderer-parity',setup(b){
      b.onResolve({filter:/^pixi\.js$/},()=>({path:'pixi',namespace:'parity'}));
      b.onLoad({filter:/.*/,namespace:'parity'},()=>({contents:stub,loader:'js'}));
      if(original) b.onLoad({filter:/(buildingMesh|facilityMesh|vehicleMesh)\.ts$/},args=>({
        contents:execFileSync('git',['show',baseline+':'+relative(resolve('.'),args.path).replaceAll('\\','/')],{encoding:'utf8'}),loader:'ts'}));
    }}] });
  mkdirSync('.check', { recursive: true });
  const output = resolve('.check', `mesh-parity-${original ? 'baseline' : 'current'}.mjs`);
  writeFileSync(output, bundled.outputFiles[0].text);
  return (await import(pathToFileURL(output).href)).default;
}
assert.deepEqual(await snapshot(false),await snapshot(true));
console.log('PASS renderer parity: 17 populated/empty/negative-coordinate/vehicle-shrink snapshots; positions, UVs and indices identical');
