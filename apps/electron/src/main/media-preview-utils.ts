/**
 * Pure helpers for the media-preview:// handler.
 *
 * Split from the handler so they can be tested without importing electron —
 * same split as network-proxy-utils.ts.
 */

/**
 * Parse a single-range `Range: bytes=start-end` header against a known size.
 *
 * Returns null for anything this handler will not serve — a malformed header, a
 * start past the end of the file, or the multi-range form. Null means "send the
 * whole file", which is always a correct response to a range request.
 */
export function parseByteRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null

  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return null

  // A suffix range ("-500") asks for the last N bytes.
  if (!rawStart) {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= size) return null
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1
  if (!Number.isFinite(end) || end < start) return null
  return { start, end }
}
