/**
 * Loopback address detection for the local-access auth bypass.
 *
 * The only trustworthy source for "is this request from this machine" is the
 * TCP peer address of the socket. Host / X-Forwarded-For / Origin headers are
 * all attacker-controlled and must never feed into this decision.
 */

/**
 * True when `address` is a loopback peer address as reported by a TCP socket.
 *
 * Covers the whole 127.0.0.0/8 range (not just 127.0.0.1), IPv6 `::1`, and the
 * IPv4-mapped IPv6 form Node reports on dual-stack sockets (`::ffff:127.0.0.1`).
 */
export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false

  // Node reports IPv6 scoped addresses like `fe80::1%lo0` — drop the zone.
  let addr = address.trim().toLowerCase().split('%')[0]!

  if (addr === '::1') return true

  // Dual-stack sockets report IPv4 peers as `::ffff:127.0.0.1`.
  if (addr.startsWith('::ffff:')) addr = addr.slice('::ffff:'.length)

  const octets = addr.split('.')
  if (octets.length !== 4) return false

  // Every octet must be a plain decimal number — reject `127.0.0.01`, `127.0.0.1x`,
  // and other lenient forms rather than guessing what the OS meant.
  const parsed = octets.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1))
  if (parsed.some((n) => n < 0 || n > 255)) return false

  return parsed[0] === 127
}
