/**
 * ResourceLoader for the pi-agent-server subprocess.
 *
 * `createAgentSession` accepts a custom `resourceLoader` (SDK contract: when
 * one is provided the SDK does NOT construct or reload its own loader — see
 * dist/core/sdk.js). This class delegates everything to a `DefaultResourceLoader`
 * constructed the way the SDK would construct it internally
 * (`{ cwd, agentDir, settingsManager }`), plus whatever seams and inline
 * extensions the caller supplies.
 *
 * The loader is the only attachment point for `noSkills` / `skillsOverride` /
 * `systemPromptOverride`, and Pi consults it on every system-prompt rebuild —
 * which is why the session always gets one, with or without MCP.
 *
 * When MCP is on, two inline extension factories — the pi-mcp-adapter and the
 * Bitlab host bridge — are appended to the discovered extension set.
 * `getExtensions()` then returns `[...delegated extensions, adapterExtension,
 * hostExtension]` with the loader's errors/diagnostics and shared `runtime`
 * preserved: DefaultResourceLoader appends inline factories during `reload()`
 * (loadFinalExtensionSet), merging their loaded `Extension` objects and any
 * load errors into the same result. Both inline extensions share the
 * loader-owned event bus (`pi.events`), which is how the adapter's broker
 * events reach the host bridge.
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
import type { SkillLoaderSeams } from './skill-bridge.ts';

/**
 * Parameter types not re-exported from the SDK root (its package.json only
 * exposes "." and "./rpc-entry"). Deriving them from the public ResourceLoader
 * interface keeps us tied to the real SDK shape instead of re-declaring it.
 */
type ExtendResourcesPaths = Parameters<ResourceLoader['extendResources']>[0];
type ReloadOptions = Parameters<ResourceLoader['reload']>[0];

export interface BitlabResourceLoaderOptions {
  /** Session working directory (same value passed to createAgentSession). */
  cwd: string;
  /** Isolated agent dir — the SDK would default this to ~/.pi/agent. */
  agentDir: string;
  /** Same settings manager the session itself uses, where the session has one. */
  settingsManager?: SettingsManager;
  /** Skill catalog wiring. Omitted only where no catalog applies. */
  skillSeams?: SkillLoaderSeams;
  /** pi-mcp-adapter inline extension (see mcp/mcp-extension.ts). MCP only. */
  adapterExtension?: InlineExtension;
  /** Host bridge inline extension forwarding broker events to stdout. MCP only. */
  hostExtension?: InlineExtension;
}

export class BitlabResourceLoader implements ResourceLoader {
  private readonly delegate: DefaultResourceLoader;
  private readonly skillSeams?: SkillLoaderSeams;

  constructor(options: BitlabResourceLoaderOptions) {
    const extensionFactories = [options.adapterExtension, options.hostExtension].filter(
      (extension): extension is InlineExtension => extension !== undefined
    );
    this.delegate = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir: options.agentDir,
      settingsManager: options.settingsManager,
      // Loaded (fresh) on every reload() — the adapter factory snapshots the
      // current MCP config at invocation time, so a reload picks up updates.
      ...(extensionFactories.length ? { extensionFactories } : {}),
      // Only the scan switch goes to the delegate. The catalog and the prompt
      // are answered here instead (see getSkills/getSystemPrompt), because the
      // delegate caches its resolved values until the next reload() — and
      // reload() is far too heavy to run every time a SKILL.md is edited.
      ...(options.skillSeams ? { noSkills: options.skillSeams.noSkills } : {}),
    });
    this.skillSeams = options.skillSeams;
  }

  /**
   * Delegated extensions plus any inline MCP extensions. DefaultResourceLoader
   * appends inline-factory results to its own discovered set (preserving
   * errors and the shared runtime), so the delegate result already contains
   * them — visible as `<inline:bitlab-mcp-adapter>` / `<inline:bitlab-mcp-host>`
   * extension paths.
   */
  getExtensions(): LoadExtensionsResult {
    return this.delegate.getExtensions();
  }

  /**
   * Answered from the catalog on every call, so a skill edited mid-session is
   * visible to the very next system-prompt rebuild.
   */
  getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
    if (!this.skillSeams) return this.delegate.getSkills();
    return this.skillSeams.skillsOverride({ skills: [], diagnostics: [] });
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

  /** Bitlab's base prompt changes per turn, so it is read fresh as well. */
  getSystemPrompt(): string | undefined {
    if (!this.skillSeams) return this.delegate.getSystemPrompt();
    return this.skillSeams.systemPromptOverride(this.delegate.getSystemPrompt());
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
