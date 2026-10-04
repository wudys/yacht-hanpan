import type { Collider, World } from '@dimforge/rapier3d-deterministic';

export function hasSolverContact(world: World, first: Collider, second: Collider): boolean {
  let active = false;
  world.contactPair(first, second, (manifold) => {
    if (manifold.numSolverContacts() > 0) active = true;
  });
  return active;
}
