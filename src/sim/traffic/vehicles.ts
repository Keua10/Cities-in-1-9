import type { TripPurpose } from '../citizens';
import type { Route } from './router';
export const enum VehicleKind{Car=0,Truck=1}
export interface Vehicle{kind:VehicleKind;tier:number;purpose:TripPurpose;route:Route;routeIdx:number;tileT:number;lane:number;speed:number;dir:number;destTx:number;destTy:number;}
