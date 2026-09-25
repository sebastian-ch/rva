/** Messages between the main thread and the traffic worker, and the pose buffer layout. */
import type { CarPathMeta } from './graph';
import type { RailPathMeta } from './trains';

/** Vehicle kinds by index in the pose buffer; must be prop kinds the pool can draw. */
export const VEHICLE_KIND_NAMES = ['car', 'suv', 'pickup', 'van', 'bus', 'locomotive', 'boxcar', 'hopper', 'tank_car', 'coach'] as const;
export type VehicleKindName = (typeof VEHICLE_KIND_NAMES)[number];

/** The tail of VEHICLE_KIND_NAMES that belongs to trains; each one is one car of a consist. */
export const RAIL_KIND_NAMES = ['locomotive', 'boxcar', 'hopper', 'tank_car', 'coach'] as const;
export type RailKindName = (typeof RAIL_KIND_NAMES)[number];

/** Body colour palette keys by index. */
export const VEHICLE_COLORS = ['car_white', 'car_silver', 'car_black', 'car_grey', 'car_red', 'car_blue', 'car_navy', 'car_green', 'car_tan', 'car_orange'] as const;
export const VEHICLE_COLOR_WEIGHTS = [24, 18, 15, 10, 8, 8, 5, 4, 4, 3];

/** Freight livery keys, indexed by the same pose field: a rail kind reads this table instead. */
export const RAIL_COLORS = ['rail_boxcar', 'rail_brown', 'rail_hopper', 'rail_green', 'rail_blue'] as const;
export const RAIL_COLOR_WEIGHTS = [26, 20, 20, 10, 8];

/** floats per vehicle slot in a pose buffer: x, y, z, heading, kind (-1 = empty), colour */
export const POSE_STRIDE = 6;
export const MAX_VEHICLES = 1500;
/** Train cars live in their own slot range above the road vehicles so the two sims never collide. */
export const MAX_RAIL_CARS = 200;
export const RAIL_SLOT_BASE = MAX_VEHICLES;
export const TOTAL_POSE_SLOTS = MAX_VEHICLES + MAX_RAIL_CARS;

/** A traffic signal (anywhere near a junction) or a stop sign (with its approach's travel direction), local frame. */
export interface JunctionControl { kind: 'signal' | 'stop'; x: number; z: number; dx?: number; dz?: number }

export interface TileMessage {
  type: 'addTile';
  tileId: string;
  paths: Float32Array[];
  meta: CarPathMeta[];
  controls?: JunctionControl[];
  railPaths?: Float32Array[];
  railMeta?: RailPathMeta[];
}
export interface RemoveMessage { type: 'removeTile'; tileId: string }
export interface ParamsMessage { type: 'setParams'; paused?: boolean; density?: number; seed?: number; trains?: boolean }
export type ToWorker = TileMessage | RemoveMessage | ParamsMessage;

export interface PosesMessage { type: 'poses'; t: number; buf: Float32Array }
export interface StatsMessage { type: 'stats'; vehicles: number; edges: number; msPerStep: number; trains: number; railEdges: number }
export type FromWorker = PosesMessage | StatsMessage;
