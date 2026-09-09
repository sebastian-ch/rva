/// <reference lib="webworker" />
/** Traffic worker: owns the road graph and the IDM simulation, streams pose buffers at a fixed rate. */
import { DT, TrafficSim } from './traffic/sim';
import { MAX_VEHICLES, POSE_STRIDE, type FromWorker, type ToWorker } from './traffic/protocol';

const sim = new TrafficSim(1);
const post = (msg: FromWorker, transfer?: Transferable[]) => (self as unknown as Worker).postMessage(msg, transfer ?? []);

let stepMs = 0;
let steps = 0;
let running = false;

function tick() {
  const t0 = performance.now();
  sim.step(DT);
  const buf = new Float32Array(MAX_VEHICLES * POSE_STRIDE);
  sim.writePoses(buf);
  post({ type: 'poses', t: performance.now(), buf }, [buf.buffer]);
  stepMs += performance.now() - t0;
  if (++steps >= 40) {
    post({ type: 'stats', vehicles: sim.vehicles.size, edges: sim.graph.edges.size, msPerStep: stepMs / steps });
    stepMs = 0; steps = 0;
  }
}

function ensureRunning() {
  if (running) return;
  running = true;
  setInterval(tick, DT * 1000);
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'addTile': sim.addTile(m.tileId, m.paths, m.meta); ensureRunning(); break;
    case 'removeTile': sim.removeTile(m.tileId); break;
    case 'setParams':
      if (m.paused !== undefined) sim.paused = m.paused;
      if (m.density !== undefined) sim.densityScale = m.density;
      if (m.seed !== undefined) sim.reseed(m.seed);
      break;
  }
};
