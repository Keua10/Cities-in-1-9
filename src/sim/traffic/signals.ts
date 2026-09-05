import { WORLD_SEED } from '../../core/constants';
import { roadMask } from '../../world/build';
import type { World } from '../../world/world';
import { simHash } from '../buildings';
import { SIGNAL_CYCLE_MS, SIGNAL_GREEN_MS, SIGNAL_YELLOW_MS } from '../simConstants';
export const enum SignalPhase{NSGreen=0,NSYellow=1,EWGreen=2,EWYellow=3}
export function hasSignal(world:World,tx:number,ty:number):boolean{let m=roadMask(world,tx,ty),n=0;for(let i=0;i<4;i++)n+=(m>>i)&1;return n>=3;}
export function phaseAt(tx:number,ty:number,timeMs:number):SignalPhase{const off=simHash(WORLD_SEED,tx,ty,0)%SIGNAL_CYCLE_MS;const t=((timeMs+off)%SIGNAL_CYCLE_MS+SIGNAL_CYCLE_MS)%SIGNAL_CYCLE_MS;const a=SIGNAL_GREEN_MS,b=a+SIGNAL_YELLOW_MS,c=b+SIGNAL_GREEN_MS;return t<a?SignalPhase.NSGreen:t<b?SignalPhase.NSYellow:t<c?SignalPhase.EWGreen:SignalPhase.EWYellow;}
export function canEnter(tx:number,ty:number,dir:number,timeMs:number):boolean{const p=phaseAt(tx,ty,timeMs);const ns=dir===0||dir===2;return ns?(p===SignalPhase.NSGreen):(p===SignalPhase.EWGreen);}
