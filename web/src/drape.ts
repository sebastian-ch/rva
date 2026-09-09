import * as THREE from 'three';

/** Refine where an independently triangulated overlay disagrees with the ground beneath it. */
export function conformTriangle(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3,
  height: (x: number, z: number, current: number) => number,
  emit: (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => void, depth = 0) {
  const midpoint = (u: THREE.Vector3, v: THREE.Vector3) => u.clone().add(v).multiplyScalar(0.5);
  const ab=midpoint(a,b), bc=midpoint(b,c), ca=midpoint(c,a), center=a.clone().add(b).add(c).multiplyScalar(1/3);
  let error=0;
  for (const p of [ab,bc,ca,center]) { const y=height(p.x,p.z,p.y); error=Math.max(error,Math.abs(y-p.y)); p.y=y; }
  // Sparse probes can all miss a narrow road cut inside a large land triangle.
  // Bound horizontal edge length before trusting the error estimate (terrain cells are 10 m).
  const span = Math.max(...[[a,b],[b,c],[c,a]].map(([u,v]) => Math.hypot(u.x-v.x,u.z-v.z)));
  if ((error <= 0.025 && span <= 8) || depth >= 9) { emit(a,b,c); return; }
  conformTriangle(a,ab,ca,height,emit,depth+1); conformTriangle(ab,b,bc,height,emit,depth+1);
  conformTriangle(ca,bc,c,height,emit,depth+1); conformTriangle(ab,bc,ca,height,emit,depth+1);
}
