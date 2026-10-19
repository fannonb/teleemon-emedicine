/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly MEDPLUM_BASE_URL?: string;
  readonly MEDPLUM_CLIENT_ID?: string;
  /** Restricts sign-in to the practice project (written by `npm run setup`). */
  readonly MEDPLUM_PROJECT_ID?: string;
  readonly TELEEMON_IDLE_MINUTES?: string;
  /** 'live' only once a contracted e-prescribing vendor is connected; otherwise the sandbox labels show. */
  readonly TELEEMON_ERX_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}
