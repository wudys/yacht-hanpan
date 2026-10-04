import { useEffect, useRef, useState } from 'react';

export function useViewerTurnSummaryEmphasis(
  identity: string | null,
  boardVisible: boolean,
): boolean {
  const consumedIdentityRef = useRef<string | null>(null);
  const [emphasized, setEmphasized] = useState(false);

  useEffect(() => {
    if (!boardVisible || identity === null) {
      setEmphasized(false);
      return undefined;
    }
    if (consumedIdentityRef.current !== identity) {
      consumedIdentityRef.current = identity;
      setEmphasized(true);
    }

    const timer = globalThis.setTimeout(() => setEmphasized(false), 300);
    return () => globalThis.clearTimeout(timer);
  }, [boardVisible, identity]);

  return emphasized;
}

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
