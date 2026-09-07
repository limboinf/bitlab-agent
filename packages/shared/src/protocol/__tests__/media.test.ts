import { describe, expect, it } from 'bun:test'
import {
  isInlinePlayableMedia,
  mediaExtension,
  mediaTypeForPath,
  mimeTypeForPath,
} from '../media.ts'

describe('mediaTypeForPath', () => {
  it('classifies the three media families', () => {
    expect(mediaTypeForPath('/s/data/render.png')).toBe('image')
    expect(mediaTypeForPath('/s/data/clip.mp4')).toBe('video')
    expect(mediaTypeForPath('/s/data/voice.mp3')).toBe('audio')
  })

  it('still calls a format nothing can decode media', () => {
    // A HEIC is a picture that opens elsewhere, not a non-picture.
    expect(mediaTypeForPath('/s/data/shot.heic')).toBe('image')
    expect(mediaTypeForPath('/s/data/raw.mkv')).toBe('video')
  })

  it('is not fooled by non-media', () => {
    expect(mediaTypeForPath('/s/data/report.md')).toBeNull()
    expect(mediaTypeForPath('/s/data/Makefile')).toBeNull()
    expect(mediaTypeForPath('/s/data/archive.tar.gz')).toBeNull()
  })

  it('reads the extension case-insensitively and from Windows paths', () => {
    expect(mediaExtension('C:\\out\\Render.PNG')).toBe('png')
    expect(mediaTypeForPath('C:\\out\\Render.PNG')).toBe('image')
  })
})

describe('isInlinePlayableMedia', () => {
  it('separates what the renderer can decode from what it cannot', () => {
    expect(isInlinePlayableMedia('/s/clip.mp4')).toBe(true)
    expect(isInlinePlayableMedia('/s/clip.webm')).toBe(true)
    expect(isInlinePlayableMedia('/s/clip.mkv')).toBe(false)
    expect(isInlinePlayableMedia('/s/shot.heic')).toBe(false)
    expect(isInlinePlayableMedia('/s/notes.md')).toBe(false)
  })
})

describe('mimeTypeForPath', () => {
  it('maps known media extensions and nothing else', () => {
    expect(mimeTypeForPath('/s/a.mp4')).toBe('video/mp4')
    expect(mimeTypeForPath('/s/a.m4a')).toBe('audio/mp4')
    expect(mimeTypeForPath('/s/a.svg')).toBe('image/svg+xml')
    expect(mimeTypeForPath('/s/a.md')).toBeNull()
  })
})
