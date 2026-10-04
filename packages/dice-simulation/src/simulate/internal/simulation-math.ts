export type VectorTuple = [number, number, number];
export type QuaternionTuple = [number, number, number, number];

export function quatDistance(a: QuaternionTuple, b: QuaternionTuple): number {
  const dot = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
  return 2 * Math.acos(dot);
}

export function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
