import { type CupGeometry, DEFAULT_CUP_GEOMETRY } from '../../contract/cup-geometry';

export type CupSpec = CupGeometry;
export const DEFAULT_CUP_SPEC = DEFAULT_CUP_GEOMETRY;

export function cupInteriorDimensions(spec: CupSpec = DEFAULT_CUP_SPEC) {
  return {
    innerWidth: round(spec.innerRadius * 2),
    innerDepth: round(spec.innerRadius * 2),
    innerHeight: round(spec.innerHeight),
  };
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
