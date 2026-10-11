/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEMO_NOTICE_ENABLED?: string;
  readonly VITE_GAME_SERVER_URL?: string;
  readonly VITE_SITE_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
