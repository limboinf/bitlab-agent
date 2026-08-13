// Version is read from package.json — the single source of truth.
// All build scripts, CI workflows, and runtime code use this value.
import pkg from '../../package.json';

export const APP_VERSION: string = pkg.version;

export function getAppVersion(): string {
  return APP_VERSION;
}
