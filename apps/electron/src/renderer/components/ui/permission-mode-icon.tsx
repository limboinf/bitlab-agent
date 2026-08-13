import { PERMISSION_MODE_CONFIG, type PermissionMode } from '@bitlab/shared/agent/modes'

/**
 * Stroke icon for a permission mode, drawn from the shared mode config so the
 * composer chip, the popover, and the slash menu can never drift apart.
 */
export function PermissionModeIcon({ mode, className }: { mode: PermissionMode; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={PERMISSION_MODE_CONFIG[mode].svgPath} />
    </svg>
  )
}
