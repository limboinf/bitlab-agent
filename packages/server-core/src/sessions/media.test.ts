import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearMediaProbeCache, probeMediaMetadata, sniffMediaMimeType } from './media.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bitlab-media-'))
  clearMediaProbeCache()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A 2×3 PNG: signature, then an IHDR carrying the dimensions. */
function pngBytes(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.write('IHDR', 12, 'latin1')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

/** A GIF87a header, which carries the size little-endian at offset 6. */
function gifBytes(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(16)
  buffer.write('GIF87a', 0, 'latin1')
  buffer.writeUInt16LE(width, 6)
  buffer.writeUInt16LE(height, 8)
  return buffer
}

/** An ISO-BMFF `ftyp` box with the given brand. */
function ftypBytes(brand: string): Buffer {
  const buffer = Buffer.alloc(32)
  buffer.writeUInt32BE(32, 0)
  buffer.write('ftyp', 4, 'latin1')
  buffer.write(brand, 8, 'latin1')
  return buffer
}

function write(name: string, bytes: Buffer): string {
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return path
}

describe('sniffMediaMimeType', () => {
  it('reads the container from the leading bytes', () => {
    expect(sniffMediaMimeType(pngBytes(1, 1))).toBe('image/png')
    expect(sniffMediaMimeType(gifBytes(1, 1))).toBe('image/gif')
    expect(sniffMediaMimeType(ftypBytes('isom'))).toBe('video/mp4')
    expect(sniffMediaMimeType(ftypBytes('M4A '))).toBe('audio/mp4')
    expect(sniffMediaMimeType(Buffer.from('ID3\x03\x00', 'latin1'))).toBe('audio/mpeg')
  })

  it('says nothing about bytes it does not recognise', () => {
    expect(sniffMediaMimeType(Buffer.from('# just markdown\n'))).toBeNull()
  })
})

describe('probeMediaMetadata', () => {
  it('reports the probed MIME type, size and image dimensions', async () => {
    const path = write('render.png', pngBytes(1024, 768))

    const metadata = await probeMediaMetadata(path)

    expect(metadata).toEqual({
      mimeType: 'image/png',
      byteSize: 33,
      width: 1024,
      height: 768,
    })
  })

  it('trusts the bytes over the extension inside one family', async () => {
    // A QuickTime container written as .mp4 is still the video the card promised.
    const path = write('clip.mp4', ftypBytes('qt  '))

    expect((await probeMediaMetadata(path))?.mimeType).toBe('video/quicktime')
  })

  it('refuses a file whose bytes are not the media it claims', async () => {
    const path = write('clip.mp4', pngBytes(4, 4))

    expect(await probeMediaMetadata(path)).toBeNull()
  })

  it('ignores files that are not media at all', async () => {
    const path = write('notes.md', Buffer.from('# hello'))

    expect(await probeMediaMetadata(path)).toBeNull()
  })

  it('returns null for a file that is gone', async () => {
    expect(await probeMediaMetadata(join(dir, 'missing.png'))).toBeNull()
  })

  it('picks up a poster frame written beside the media', async () => {
    write('poster.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
    const path = write('clip.mp4', ftypBytes('isom'))

    expect((await probeMediaMetadata(path))?.posterPath).toBe(join(dir, 'poster.jpg'))
  })

  it('does not carry a stale probe across a rewrite', async () => {
    const path = write('render.png', pngBytes(100, 100))
    expect((await probeMediaMetadata(path))?.width).toBe(100)

    writeFileSync(path, Buffer.concat([pngBytes(300, 200), Buffer.alloc(8)]))
    expect((await probeMediaMetadata(path))?.width).toBe(300)
  })

  it('does not read bytes for SVG, which has no binary header', async () => {
    const path = write('chart.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))

    expect((await probeMediaMetadata(path))?.mimeType).toBe('image/svg+xml')
  })
})
