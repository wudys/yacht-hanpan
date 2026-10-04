// Fill public settings; the HTML bootstrap owns the initialization guard.
export function configureAnalyticsHtml(
  html: string,
  config: Readonly<{ enabled: boolean; origin: string; measurementId: string | null }>,
): string {
  const settings = JSON.stringify({
    enabled: config.enabled,
    origin: config.origin,
    measurementId: config.measurementId,
  }).replaceAll('<', '\\u003c');
  return html
    .replace('__HANPAN_ANALYTICS_CONFIG__', () => settings)
    .replace('__HANPAN_MEASUREMENT_ID__', encodeURIComponent(config.measurementId ?? ''));
}
