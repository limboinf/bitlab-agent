import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { PERMISSION_MODE_LABEL_KEYS, type PermissionMode } from '@bitlab/shared/agent/modes'
import { PermissionModeIcon } from '@/components/ui/permission-mode-icon'

/**
 * Permission control shared by the desktop popover and the compact drawer.
 *
 * The composer states the situation ("you are inside the sandbox") and offers
 * the single decision that matters — hand over full access or not. Listing
 * every mode made the user classify their own intent before typing; a switch
 * asks only whether to lift the guard rails.
 */

/** Modes are picked from a list only when all three are enabled in workspace settings. */
export function usesSimplePermissionPanel(enabledModes: PermissionMode[]): boolean {
  return !(enabledModes.includes('safe') && enabledModes.includes('ask'))
}

/** The non-full-access mode a workspace falls back to when the switch is off. */
export function guardedPermissionMode(enabledModes: PermissionMode[]): PermissionMode {
  return enabledModes.find(mode => mode !== 'allow-all') ?? 'ask'
}

/** Chip label for the current mode — state names, not mode names. */
export function permissionModeLabelKey(mode: PermissionMode): string {
  return PERMISSION_MODE_LABEL_KEYS[mode].label
}

/** Trigger chip styling — the default state recedes, full access stands out. */
export const PERMISSION_CHIP_STYLES: Record<PermissionMode, { className: string; shadowVar: string }> = {
  safe: {
    className: 'bg-foreground/5 text-foreground/60',
    shadowVar: 'var(--foreground-rgb)',
  },
  ask: {
    className: 'bg-foreground/5 text-foreground/70',
    shadowVar: 'var(--foreground-rgb)',
  },
  'allow-all': {
    className: 'bg-accent/5 text-accent',
    shadowVar: 'var(--accent-rgb)',
  },
}

interface PermissionModePanelProps {
  permissionMode: PermissionMode
  enabledModes: PermissionMode[]
  onPermissionModeChange: (mode: PermissionMode) => void
  className?: string
}

export function PermissionModePanel({
  permissionMode,
  enabledModes,
  onPermissionModeChange,
  className,
}: PermissionModePanelProps) {
  const { t } = useTranslation()
  const fullAccess = permissionMode === 'allow-all'

  const handleToggle = React.useCallback((checked: boolean) => {
    onPermissionModeChange(checked ? 'allow-all' : guardedPermissionMode(enabledModes))
  }, [enabledModes, onPermissionModeChange])

  return (
    <div className={cn('w-[280px] select-none p-1', className)}>
      {/* Current state — icon badge carries the color, so the text can stay calm */}
      <div className="px-2.5 pb-2.5 pt-2">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] transition-colors',
              fullAccess ? 'bg-accent/10 text-accent' : 'bg-foreground/[0.06] text-foreground/70',
            )}
          >
            <PermissionModeIcon mode={permissionMode} className="h-3.5 w-3.5" />
          </span>
          <span className={cn('text-[13px] font-medium', fullAccess && 'text-accent')}>
            {t(PERMISSION_MODE_LABEL_KEYS[permissionMode].label)}
          </span>
        </div>
        <p className="mt-2 text-[12px] leading-[1.6] text-muted-foreground">
          {t(PERMISSION_MODE_LABEL_KEYS[permissionMode].description)}
        </p>
      </div>

      <div className="mx-1 h-px bg-border/50" />

      {/* The one decision this control exists for */}
      <label
        className={cn(
          'mt-1 flex cursor-pointer items-center justify-between gap-3 rounded-[6px] px-2.5 py-2',
          'transition-colors hover:bg-foreground/5',
        )}
      >
        <span className="min-w-0">
          <span className="block text-[13px] font-medium">{t('mode.allowFullAccess')}</span>
          <span className="mt-0.5 block text-[11.5px] leading-snug text-muted-foreground">
            {t('mode.allowFullAccessHint')}
          </span>
        </span>
        <Switch checked={fullAccess} onCheckedChange={handleToggle} className="shrink-0" />
      </label>
    </div>
  )
}
