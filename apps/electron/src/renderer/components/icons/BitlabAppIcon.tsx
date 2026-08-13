import bitlabIcon from "@/assets/bitlab_mark.png"

interface BitlabAppIconProps {
  className?: string
  size?: number
}

/**
 * BitlabAppIcon - Displays the Bitlab app icon.
 */
export function BitlabAppIcon({ className, size = 64 }: BitlabAppIconProps) {
  return (
    <img
      src={bitlabIcon}
      alt="Bitlab"
      width={size}
      height={size}
      className={className}
    />
  )
}
