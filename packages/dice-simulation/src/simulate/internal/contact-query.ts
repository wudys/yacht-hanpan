import type { Collider, World } from '@dimforge/rapier3d-deterministic';

export function hasSolverContact(world: World, first: Collider, second: Collider): boolean {
  let active = false;
  world.contactPair(first, second, (manifold) => {
    if (manifold.numSolverContacts() > 0) active = true;
  });
  return active;
}

export function hasLowerSupportContact(world: World, die: Collider, supports: Collider[]): boolean {
  let hasLowerContact = false;

  supports.forEach((support) => {
    world.contactPair(die, support, (manifold, flipped) => {
      // A rounded edge can carry weight at or above the centre of the supported
      // die. The contact normal, not contact-point height, identifies support.
      const upwardNormal = manifold.normal().y * (flipped ? 1 : -1);
      if (upwardNormal <= 0.15) return;
      // Solver contacts also include separated, predicted collisions. Those
      // neighbours must not act as current supports or steer the escape push.
      for (let index = 0; index < manifold.numSolverContacts(); index += 1) {
        if (manifold.solverContactDist(index) <= 0.005) hasLowerContact = true;
      }
    });
  });
  return hasLowerContact;
}

/** Solver support and direct proximity must agree; prediction alone cannot carry weight. */
export function hasActualLowerSupportContact(
  world: World,
  die: Collider,
  support: Collider,
): boolean {
  return hasLowerSupportContact(world, die, [support]) && !!die.contactCollider(support, 0.005);
}

export function hasTouchingWallContact(world: World, die: Collider, wall: Collider): boolean {
  return hasSolverContact(world, die, wall) && !!die.contactCollider(wall, 0.005);
}
