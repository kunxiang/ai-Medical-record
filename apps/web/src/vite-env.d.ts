/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_M1_TEST_HOOKS?: string;
  readonly VITE_FIXTURE_BASE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
