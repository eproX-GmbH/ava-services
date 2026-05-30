// Side-effect-only bootstrap. Imported first by main/index.ts so the
// console.* patch is installed before any other main-process module is
// evaluated (and therefore before any of them log). See file-logger.ts
// for the rationale.
import { initFileLogger } from "./file-logger";

initFileLogger();
