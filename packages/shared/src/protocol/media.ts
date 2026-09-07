/**
 * Generated media — the message-side projection of a media artifact.
 *
 * A `SessionArtifact` is the fact: a file the agent produced, at a path, that
 * either exists or does not. `MessageMedia` is that same fact seen from one
 * assistant message: this turn made this picture, and here is what the renderer
 * needs to show it without touching the file itself.
 *
 * What deliberately does *not* live here: base64 payloads, binary blobs and
 * remote URLs. A message that carried the bytes would grow without bound, and a
 * message that carried a provider URL would stop working the moment the URL
 * expired. The reference plus server-probed metadata is the whole DTO.
 */

export type GeneratedMediaType = 'image' | 'video' | 'audio'

/**
 * What the card should show.
 *
 * `unsupported` is the honest state for a file this host cannot decode — an
 * HEIC still, a ProRes movie. It is not an error: the file is fine, the viewer
 * is not, and the way out is the system application.
 */
export type MediaPreviewStatus =
  | 'generating'
  | 'ready'
  | 'missing'
  | 'unsupported'
  | 'error'

export type MediaErrorCode =
  | 'generation_failed'
  | 'file_missing'
  | 'permission_denied'
  | 'codec_unsupported'
  | 'read_failed'

/**
 * Server-probed facts about one media file.
 *
 * Every field is measured, never inferred from the file name. `durationMs` is
 * absent until something actually decodes the container — the media element
 * reports its own duration once loaded, which is why the probe does not try to
 * parse every codec's header.
 */
export interface MediaMetadata {
  mimeType: string
  byteSize?: number
  width?: number
  height?: number
  durationMs?: number
  /** Absolute path of a persisted poster frame, when one was produced alongside. */
  posterPath?: string
}

export interface MessageMedia {
  /** Stable identity: the artifact path. Not an index, not a thumbnail URL. */
  id: string
  /** The persisted message this media hangs under. Never "the last message". */
  messageId: string
  /** Must match `SessionArtifact.path` exactly. */
  artifactPath: string
  name: string
  mediaType: GeneratedMediaType
  metadata: MediaMetadata
  status: MediaPreviewStatus
  errorCode?: MediaErrorCode
}

// ---------------------------------------------------------------------------
// Formats
//
// Two axes, and they are not the same question: *is this media at all* decides
// whether a file becomes a card, and *can this host play it* decides whether
// the card gets a player or a hand-off to the system application. Extension is
// only the first pass — the server probes the real MIME, and the player asks
// `canPlayType` before claiming it can play anything.
// ---------------------------------------------------------------------------

/** Formats a Chromium-class renderer decodes natively. */
export const PLAYABLE_MEDIA_EXTENSIONS: Record<GeneratedMediaType, readonly string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'],
  video: ['mp4', 'webm', 'm4v', 'ogv', 'mov'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'weba'],
}

/**
 * Media we recognise but hand to the OS: no browser codec (HEIC, TIFF), or a
 * container whose codecs usually are not web codecs (MKV, AVI, WMV).
 */
export const EXTERNAL_MEDIA_EXTENSIONS: Record<GeneratedMediaType, readonly string[]> = {
  image: ['heic', 'heif', 'tiff', 'tif'],
  video: ['mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'mts', 'm2ts'],
  audio: ['wma', 'aiff', 'aif', 'amr', 'mid', 'midi'],
}

const MEDIA_TYPE_BY_EXTENSION = new Map<string, GeneratedMediaType>()
for (const table of [PLAYABLE_MEDIA_EXTENSIONS, EXTERNAL_MEDIA_EXTENSIONS]) {
  for (const [mediaType, extensions] of Object.entries(table)) {
    for (const extension of extensions) {
      MEDIA_TYPE_BY_EXTENSION.set(extension, mediaType as GeneratedMediaType)
    }
  }
}

const PLAYABLE_EXTENSION_SET = new Set(Object.values(PLAYABLE_MEDIA_EXTENSIONS).flat())

/** MIME types by extension. Used for the initial guess and for serving bytes. */
const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  weba: 'audio/webm',
}

/** Lowercased extension of a path, without the dot. Empty when there is none. */
export function mediaExtension(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? filePath
  const dotIndex = name.lastIndexOf('.')
  if (dotIndex <= 0) return ''
  return name.slice(dotIndex + 1).toLowerCase()
}

/** The media type of a path, or null when the path is not media at all. */
export function mediaTypeForPath(filePath: string): GeneratedMediaType | null {
  return MEDIA_TYPE_BY_EXTENSION.get(mediaExtension(filePath)) ?? null
}

/**
 * Whether this host stands a chance of rendering the file inline.
 *
 * A `true` here is a candidate, not a promise — the element's own `canPlayType`
 * and the actual load are what decide. A `false` is definite: no codec, so the
 * card offers the system application instead of a player that would never start.
 */
export function isInlinePlayableMedia(filePath: string): boolean {
  return PLAYABLE_EXTENSION_SET.has(mediaExtension(filePath))
}

/** Best-effort MIME type from the extension alone. Null when unknown. */
export function mimeTypeForPath(filePath: string): string | null {
  return MIME_BY_EXTENSION[mediaExtension(filePath)] ?? null
}
