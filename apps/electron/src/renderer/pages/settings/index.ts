/**
 * Settings Pages
 *
 * All pages that appear under the settings navigator.
 */

export { default as SettingsNavigator } from './SettingsNavigator'
export { default as AppSettingsPage } from './AppSettingsPage'
export { default as AiSettingsPage } from './AiSettingsPage'
export { default as AppearanceSettingsPage } from './AppearanceSettingsPage'
export { default as InputSettingsPage } from './InputSettingsPage'
export { default as WorkspaceSettingsPage } from './WorkspaceSettingsPage'
export { default as PermissionsSettingsPage } from './PermissionsSettingsPage'
export { default as ShortcutsPage } from './ShortcutsPage'
export { default as PreferencesPage } from './PreferencesPage'

// Page metadata lives outside the component modules so the pages stay
// Fast-Refresh safe (a `.tsx` module may only export components).
export {
  AiSettingsMeta,
  AppSettingsMeta,
  AppearanceMeta,
  InputMeta,
  McpMeta,
  PermissionsMeta,
  PluginsMeta,
  PreferencesMeta,
  SettingsNavigatorMeta,
  ShortcutsMeta,
  WorkspaceSettingsMeta,
} from './page-meta'

// Re-export types
export type { DetailsPageMeta } from '@/lib/navigation-registry'
