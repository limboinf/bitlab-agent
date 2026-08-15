/**
 * Details-page metadata for the settings navigator.
 *
 * Kept in a plain module rather than next to each page component: a `.tsx`
 * file that exports both a component and a value is not Fast-Refresh safe
 * (vite-plugin-react invalidates the module instead of hot-updating it).
 */

import type { DetailsPageMeta } from '@/lib/navigation-registry'

const settingsMeta = (slug: string): DetailsPageMeta => ({ navigator: 'settings', slug })

export const SettingsNavigatorMeta = settingsMeta('navigator')
export const AppSettingsMeta = settingsMeta('app')
export const AiSettingsMeta = settingsMeta('ai')
export const AppearanceMeta = settingsMeta('appearance')
export const InputMeta = settingsMeta('input')
export const WorkspaceSettingsMeta = settingsMeta('workspace')
export const PermissionsMeta = settingsMeta('permissions')
export const PluginsMeta = settingsMeta('plugins')
export const McpMeta = settingsMeta('mcp')
export const ShortcutsMeta = settingsMeta('shortcuts')
export const PreferencesMeta = settingsMeta('preferences')
