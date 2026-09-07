import { describe, expect, it } from 'bun:test'
import { buildMediaPreviewUrl, mediaPreviewPathnameToFilePath } from '../../shared/media-preview-url'
import { parseByteRange } from '../media-preview-utils'

describe('media-preview URLs', () => {
  it('round-trips a POSIX path', () => {
    const url = new URL(buildMediaPreviewUrl('/Users/me/data/clip.mp4'))
    expect(mediaPreviewPathnameToFilePath(url.pathname)).toBe('/Users/me/data/clip.mp4')
  })

  it('round-trips a Windows path', () => {
    const url = new URL(buildMediaPreviewUrl('C:\\Users\\me\\data\\clip.mp4'))
    expect(mediaPreviewPathnameToFilePath(url.pathname)).toBe('C:/Users/me/data/clip.mp4')
  })

  it('survives spaces and other characters a file name may carry', () => {
    const path = '/Users/me/data/first take #2.mp4'
    const url = new URL(buildMediaPreviewUrl(path))
    expect(mediaPreviewPathnameToFilePath(url.pathname)).toBe(path)
  })
})

describe('parseByteRange', () => {
  it('reads an explicit range', () => {
    expect(parseByteRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 })
  })

  it('runs an open-ended range to the last byte', () => {
    expect(parseByteRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 })
  })

  it('reads a suffix range from the end', () => {
    expect(parseByteRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
  })

  it('clamps an end past the file', () => {
    expect(parseByteRange('bytes=0-9999', 1000)).toEqual({ start: 0, end: 999 })
  })

  it('refuses ranges that cannot be served', () => {
    expect(parseByteRange(null, 1000)).toBeNull()
    expect(parseByteRange('bytes=1000-', 1000)).toBeNull()
    expect(parseByteRange('bytes=200-100', 1000)).toBeNull()
    expect(parseByteRange('items=0-10', 1000)).toBeNull()
    // Multi-range is legal HTTP the handler does not implement; a null here
    // means "serve the whole file", which is a correct response.
    expect(parseByteRange('bytes=0-10,20-30', 1000)).toBeNull()
  })
})
