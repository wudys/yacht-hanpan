import { type CupGeometry, DEFAULT_CUP_GEOMETRY } from '../../../contract/cup-geometry';

export function cupInteriorDimensions(spec: CupGeometry = DEFAULT_CUP_GEOMETRY) {
  return {
    innerWidth: round(spec.innerRadius * 2),
    innerDepth: round(spec.innerRadius * 2),
    innerHeight: round(spec.innerHeight),
  };
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
