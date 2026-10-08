const portOffset = Number(process.env.E2E_PORT_OFFSET ?? '0');
if (!Number.isInteger(portOffset) || portOffset < 0 || portOffset > 65_535 - 49_331) {
  throw new Error('E2E_PORT_OFFSET must keep test server ports between 1 and 65535');
}

export const PRODUCT_GAME_PORT = 49_330 + portOffset;
export const PRODUCT_SERVER_PORT = 49_331 + portOffset;
export const BUILT_WEB_PORT = 49_329 + portOffset;
export const PRODUCT_GAME_ORIGIN = `http://127.0.0.1:${PRODUCT_GAME_PORT}`;
export const PRODUCT_SERVER_ORIGIN = `http://127.0.0.1:${PRODUCT_SERVER_PORT}`;
export const BUILT_WEB_ORIGIN = `http://127.0.0.1:${BUILT_WEB_PORT}`;
