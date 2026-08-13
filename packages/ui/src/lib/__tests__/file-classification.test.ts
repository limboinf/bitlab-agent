import { describe, expect, it } from 'bun:test'
import { classifyFile, FILE_EXTENSIONS_PATTERN } from '../file-classification'

describe('classifyFile', () => {
  it('routes HTML to its own preview type, not the code viewer', () => {
    expect(classifyFile('weather-card/index.html')).toEqual({ type: 'html', canPreview: true })
    expect(classifyFile('/tmp/page.HTM')).toEqual({ type: 'html', canPreview: true })
  })

  it('leaves the other classifications alone', () => {
    expect(classifyFile('src/app.tsx').type).toBe('code')
    expect(classifyFile('style.css').type).toBe('code')
    expect(classifyFile('README.md').type).toBe('markdown')
    expect(classifyFile('data.json').type).toBe('json')
    expect(classifyFile('shot.png').type).toBe('image')
    expect(classifyFile('doc.pdf').type).toBe('pdf')
    expect(classifyFile('notes.txt').type).toBe('text')
  })

  it('still detects .html as a file link', () => {
    expect(FILE_EXTENSIONS_PATTERN.split('|')).toContain('html')
    expect(FILE_EXTENSIONS_PATTERN.split('|')).toContain('htm')
  })

  it('has no preview for unknown extensions', () => {
    expect(classifyFile('archive.xyz')).toEqual({ type: null, canPreview: false })
  })
})
