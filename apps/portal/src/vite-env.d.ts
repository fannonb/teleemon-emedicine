/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly MEDPLUM_BASE_URL?: string;
  readonly MEDPLUM_CLIENT_ID?: string;
  readonly MEDPLUM_PROJECT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
