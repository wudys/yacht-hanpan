import { createContext, useContext, useEffect } from 'react';

import { inactiveTelemetry, type Screen } from '@/runtime/telemetry/telemetry';
export const TelemetryContext = createContext(inactiveTelemetry);
export function useTelemetry() {
  return useContext(TelemetryContext);
}
export function useScreenTelemetry(screen: Screen | null) {
  const telemetry = useTelemetry();
  useEffect(() => {
    if (screen) telemetry.trackScreen(screen);
  }, [screen, telemetry]);
}
