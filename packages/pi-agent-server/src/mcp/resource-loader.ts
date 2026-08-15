/**
 * MCP-aware ResourceLoader for the pi-agent-server subprocess.
 *
 * `createAgentSession` accepts a custom `resourceLoader` (SDK contract: when
 * one is provided the SDK does NOT construct or reload its own loader — see
 * dist/core/sdk.js). This class delegates everything to a `DefaultResourceLoader`
 * constructed exactly the way the SDK would construct it internally
 * (`{ cwd, agentDir, settingsManager }`), except that our two inline extension
 * factories — the pi-mcp-adapter and the Bitlab host bridge — are appended to
 * the discovered extension set. `getExtensions()` therefore returns
 * `[...delegated extensions, adapterExtension, hostExtension]` with the
 * loader's errors/diagnostics and shared `runtime` preserved: DefaultResourceLoader
 * appends inline factories during `reload()` (loadFinalExtensionSet), merging
 * their loaded `Extension` objects and any load errors into the same result.
 *
 * Both inline extensions share the loader-owned event bus (`pi.events`), which
 * is how the adapter's broker events reach the host bridge.
 */

import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import type {
  InlineExtension,
  LoadExtensionsResult,
  ResourceDiagnostic,
  ResourceLoader,
  SettingsManager,
  Skill,
  Theme,
} from '@earendil-works/pi-coding-agent';
import type { PromptTemplate } from '@earendil-works/pi-coding-agent';

/**
 * Parameter types not re-exported from the SDK root (its package.json only
 * exposes "." and "./rpc-entry"). Deriving them from the public ResourceLoader
 * interface keeps us tied to the real SDK shape instead of re-declaring it.
 */
type ExtendResourcesPaths = Parameters<ResourceLoader['extendResources']>[0];
type ReloadOptions = Parameters<ResourceLoader['reload']>[0];

export interface BitlabMcpResourceLoaderOptions {
  /** Session working directory (same value passed to createAgentSession). */
  cwd: string;
  /** Isolated agent dir — the SDK would default this to ~/.pi/agent. */
  agentDir: string;
  /** Same settings manager the session itself uses. */
  settingsManager: SettingsManager;
  /** pi-mcp-adapter inline extension (see mcp-extension.ts). */
  adapterExtension: InlineExtension;
  /** Host bridge inline extension forwarding broker events to stdout. */
  hostExtension: InlineExtension;
}

export class BitlabMcpResourceLoader implements ResourceLoader {
  private readonly delegate: DefaultResourceLoader;

  constructor(options: BitlabMcpResourceLoaderOptions) {
    this.delegate = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir: options.agentDir,
      settingsManager: options.settingsManager,
      // Loaded (fresh) on every reload() — the adapter factory snapshots the
      // current MCP config at invocation time, so a reload picks up updates.
      extensionFactories: [options.adapterExtension, options.hostExtension],
    });
  }

  /**
   * Delegated extensions plus the two inline MCP extensions. DefaultResourceLoader
   * appends inline-factory results to its own discovered set (preserving
   * errors and the shared runtime), so the delegate result already contains
   * them — visible as `<inline:bitlab-mcp-adapter>` / `<inline:bitlab-mcp-host>`
   * extension paths.
   */
  getExtensions(): LoadExtensionsResult {
    return this.delegate.getExtensions();
  }

  getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
    return this.delegate.getSkills();
  }

  getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
    return this.delegate.getPrompts();
  }

  getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
    return this.delegate.getThemes();
  }

  getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> } {
    return this.delegate.getAgentsFiles();
  }

  getSystemPrompt(): string | undefined {
    return this.delegate.getSystemPrompt();
  }

  getAppendSystemPrompt(): string[] {
    return this.delegate.getAppendSystemPrompt();
  }

  extendResources(paths: ExtendResourcesPaths): void {
    this.delegate.extendResources(paths);
  }

  async reload(options?: ReloadOptions): Promise<void> {
    await this.delegate.reload(options);
  }
}
