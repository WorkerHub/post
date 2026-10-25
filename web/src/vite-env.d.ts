/// <reference types="vite/client" />

declare module "*.css";

/** 构建期注入的版本号，形如 `v{version}-{build}-{shortsha}`（见 web/vite.config.ts）。 */
declare const __APP_VERSION__: string;

/** 构建期注入的构建时刻，ISO 字符串（UTC）（见 web/vite.config.ts）。 */
declare const __APP_BUILD_TIME__: string;
