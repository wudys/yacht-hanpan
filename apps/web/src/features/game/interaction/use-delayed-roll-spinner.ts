import { useEffect, useState } from 'react';

export function useDelayedRollSpinner(pending: boolean, identity: object | null): boolean {
  const [visibleIdentity, setVisibleIdentity] = useState<object | null>(null);
  useEffect(() => {
    setVisibleIdentity(null);
    if (!pending || identity === null) return;
    const timeout = window.setTimeout(() => setVisibleIdentity(identity), 600);
    return () => window.clearTimeout(timeout);
  }, [pending, identity]);
  return pending && identity !== null && visibleIdentity === identity;
}
