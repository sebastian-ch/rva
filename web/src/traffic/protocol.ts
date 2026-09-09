/** Messages between the main thread and the traffic worker, and the pose buffer layout. */
import type { CarPathMeta } from './graph';

/** Vehicle kinds by index in the pose buffer; must be prop kinds the pool can draw. */
export const VEHICLE_KIND_NAMES = ['car', 'suv', 'pickup', 'van', 'bus'] as const;
export type VehicleKindName = (typeof VEHICLE_KIND_NAMES)[number];

/** Body colour palette keys by index. */
export const VEHICLE_COLORS = ['car_white', 'car_silver', 'car_black', 'car_grey', 'car_red', 'car_blue', 'car_navy', 'car_green', 'car_tan', 'car_orange'] as const;
export const VEHICLE_COLOR_WEIGHTS = [24, 18, 15, 10, 8, 8, 5, 4, 4, 3];

/** floats per vehicle slot in a pose buffer: x, y, z, heading, kind (-1 = empty), colour */
export const POSE_STRIDE = 6;
export const MAX_VEHICLES = 1500;

export interface TileMessage { type: 'addTile'; tileId: string; paths: Float32Array[]; meta: CarPathMeta[] }
export interface RemoveMessage { type: 'removeTile'; tileId: string }
export interface ParamsMessage { type: 'setParams'; paused?: boolean; density?: number; seed?: number }
export type ToWorker = TileMessage | RemoveMessage | ParamsMessage;

export interface PosesMessage { type: 'poses'; t: number; buf: Float32Array }
export interface StatsMessage { type: 'stats'; vehicles: number; edges: number; msPerStep: number }
export type FromWorker = PosesMessage | StatsMessage;
