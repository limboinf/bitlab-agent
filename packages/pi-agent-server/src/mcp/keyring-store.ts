/**
 * In-process stand-in for `@napi-rs/keyring`, installed before pi-mcp-adapter
 * loads.
 *
 * The adapter persists MCP OAuth tokens through the OS credential store, which
 * it reaches from THIS process — a `bun` binary. macOS ties a keychain entry to
 * the code identity that created it, and `bun` is the worst possible owner for
 * one: several copies exist on a normal machine, signed by two different teams,
 * and the packaged copy is re-signed on every build. Each mismatch is another
 * "bun wants to use your confidential information" prompt.
 *
 * So the subprocess never touches the OS store. The main process owns these
 * secrets (Electron safeStorage, keyed to the stable app bundle identity) and:
 *
 *   - seeds this module over the `init` message, before any MCP server connects;
 *   - receives writes back as `mcp_secret_write` / `mcp_secret_delete`;
 *   - pushes another session's writes here as `mcp_secret_sync`.
 *
 * The adapter's store interface is synchronous, which is why reads are served
 * from the seeded snapshot rather than an IPC round-trip. Writes are the only
 * asynchronous part, and the adapter does not read a write's result back.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Everything the adapter uses from a keyring Entry. */
interface KeyringEntryApi {
  getPassword(): string | null;
  setPassword(password: string): void;
  deleteCredential(): boolean;
}

/** Notifies the main process that a secret changed. `null` payload = removed. */
export type SecretWriter = (account: string, payload: string | null) => void;

/** The only service name the adapter uses; anything else is not ours to serve. */
const MCP_AUTH_SERVICE = 'pi-mcp-adapter.oauth';

/** Set to '1' to skip the one-time keychain import (see importLegacySecret). */
const LEGACY_IMPORT_DISABLED_ENV = 'BITLAB_MCP_KEYCHAIN_IMPORT_DISABLED';

/** `null` until the main process seeds us — see requireSecrets(). */
let secrets: Map<string, string> | null = null;
let writeSecret: SecretWriter = () => {};
let installed = false;

/** Accounts already looked up in the old keychain — each is tried once. */
const legacyImportsAttempted = new Set<string>();

class BitlabKeyringEntry implements KeyringEntryApi {
  constructor(private readonly service: string, private readonly account: string) {
    if (service !== MCP_AUTH_SERVICE) {
      // Nothing else in this bundle uses @napi-rs/keyring. If that ever changes,
      // fail loudly rather than silently mixing another consumer's secrets into
      // the MCP token store.
      throw new Error(`Unexpected keyring service in the agent subprocess: ${service}`);
    }
  }

  getPassword(): string | null {
    const store = requireSecrets();
    const known = store.get(this.account);
    if (known !== undefined) return known;

    const imported = importLegacySecret(this.service, this.account);
    if (imported === null) return null;
    // Hand it to the main process straight away, so the next session is seeded
    // from the new store and this path never runs again for this account.
    store.set(this.account, imported);
    writeSecret(this.account, imported);
    return imported;
  }

  setPassword(password: string): void {
    requireSecrets().set(this.account, password);
    writeSecret(this.account, password);
  }

  deleteCredential(): boolean {
    const existed = requireSecrets().delete(this.account);
    if (existed) writeSecret(this.account, null);
    return existed;
  }
}

/**
 * Reads before the snapshot arrives are a bug, not an empty store: answering
 * "no token" would make the adapter discard a working session and ask the user
 * to authenticate again. Throwing surfaces as the adapter's
 * "credential store unavailable" path instead.
 */
function requireSecrets(): Map<string, string> {
  if (!secrets) {
    throw new Error('MCP credential snapshot has not been received from the main process yet');
  }
  return secrets;
}

/**
 * One-time read-through to the OS keychain for tokens written before Bitlab
 * moved this store into the main process.
 *
 * This is the only place the subprocess still touches the keychain, and it is
 * deliberate: this binary already sits on that entry's ACL — it created the
 * entry — so the read is silent, while the same read from the main process
 * would be a new code identity and would raise the very prompt this whole
 * change exists to remove. Whatever it finds is migrated immediately.
 *
 * Every failure mode is "no token": a missing native binding, a locked
 * keychain, a user who declines the prompt. The caller then behaves as if the
 * server was never authenticated, which is the correct fallback.
 */
function importLegacySecret(service: string, account: string): string | null {
  if (process.env[LEGACY_IMPORT_DISABLED_ENV] === '1') return null;
  if (legacyImportsAttempted.has(account)) return null;
  legacyImportsAttempted.add(account);

  try {
    return readLegacyKeychain(service, account);
  } catch {
    return null;
  }
}

/** Replaceable for tests; the default reads the real OS keychain. */
let readLegacyKeychain: (service: string, account: string) => string | null = (service, account) => {
  const Entry = loadNativeKeyringEntry();
  return Entry ? new Entry(service, account).getPassword() : null;
};

type NativeKeyringEntry = new (service: string, account: string) => KeyringEntryApi;

/** `undefined` = not probed yet, `null` = no usable binding on this platform. */
let nativeKeyringEntry: NativeKeyringEntry | null | undefined;

/**
 * Load @napi-rs/keyring's native binding by its platform package.
 *
 * The plain `@napi-rs/keyring` specifier is not usable here — this module
 * overrode it — so the platform packages are addressed directly, the same way
 * pi-mcp-adapter's own fallback loader does.
 */
function loadNativeKeyringEntry(): NativeKeyringEntry | null {
  if (nativeKeyringEntry !== undefined) return nativeKeyringEntry;
  nativeKeyringEntry = null;

  const requireFrom = createRequire(import.meta.url);
  for (const suffix of nativeBindingSuffixes()) {
    try {
      const packageJson = requireFrom.resolve(`@napi-rs/keyring-${suffix}/package.json`);
      const binding = requireFrom(join(dirname(packageJson), `keyring.${suffix}.node`)) as {
        Entry: NativeKeyringEntry;
      };
      nativeKeyringEntry = binding.Entry;
      break;
    } catch {
      // Try the next candidate; none matching means no legacy import here.
    }
  }
  return nativeKeyringEntry;
}

/** Mirrors pi-mcp-adapter's native binding target list. */
function nativeBindingSuffixes(): string[] {
  const { platform, arch } = process;
  if (platform === 'darwin') return arch === 'arm64' ? ['darwin-arm64'] : ['darwin-x64'];
  if (platform === 'win32') {
    if (arch === 'arm64') return ['win32-arm64-msvc'];
    if (arch === 'ia32') return ['win32-ia32-msvc'];
    return ['win32-x64-msvc'];
  }
  if (platform === 'linux') {
    if (arch === 'arm64') return ['linux-arm64-gnu', 'linux-arm64-musl'];
    if (arch === 'arm') return ['linux-arm-gnueabihf'];
    if (arch === 'riscv64') return ['linux-riscv64-gnu'];
    if (arch === 'x64') return ['linux-x64-gnu', 'linux-x64-musl'];
  }
  if (platform === 'freebsd' && arch === 'x64') return ['freebsd-x64'];
  return [];
}

/**
 * Register the module override. Must run before `pi-mcp-adapter` is imported —
 * the adapter resolves `@napi-rs/keyring` lazily, but only once.
 */
export function installKeyringShim(): void {
  if (installed) return;
  installed = true;
  Bun.plugin({
    name: 'bitlab-mcp-keyring',
    setup(build) {
      build.module('@napi-rs/keyring', () => ({
        exports: { Entry: BitlabKeyringEntry },
        loader: 'object',
      }));
    },
  });
}

/** Install the callback that forwards writes to the main process. */
export function setSecretWriter(writer: SecretWriter): void {
  writeSecret = writer;
}

/** Seed (or re-seed, on re-init) the snapshot the adapter reads from. */
export function seedMcpSecrets(payloads: Record<string, string> | undefined): void {
  secrets = new Map(Object.entries(payloads ?? {}));
}

/** Apply a change made by another session's subprocess. */
export function applyMcpSecretSync(account: string, payload: string | null): void {
  if (!secrets) return;
  if (payload === null) secrets.delete(account);
  else secrets.set(account, payload);
}

/** Test seam: drop the snapshot so a fresh test starts un-seeded. */
export function resetMcpSecretsForTests(): void {
  secrets = null;
  writeSecret = () => {};
  legacyImportsAttempted.clear();
}

/** Test seam: stand in for the old OS keychain. */
export function setLegacyKeychainReaderForTests(
  reader: (service: string, account: string) => string | null,
): void {
  readLegacyKeychain = reader;
}

/** Test seam: the Entry class, without going through the module override. */
export const KeyringEntryForTests = BitlabKeyringEntry;
