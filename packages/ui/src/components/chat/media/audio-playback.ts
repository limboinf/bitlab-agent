/**
 * One audio element plays at a time.
 *
 * Two audio cards in the same conversation playing over each other is not a
 * feature anyone asked for, and the browser will happily allow it. The
 * coordinator is a single module-level reference rather than context: playback
 * is a property of the app, not of a subtree, and a card in a detached overlay
 * must interrupt a card in the message list just the same.
 *
 * Video is deliberately not coordinated here. It carries its own controls and
 * starts muted, so two videos at once is a choice the user made, not an
 * accident of scrolling.
 */

let playing: HTMLMediaElement | null = null

/** Pause whatever is playing, unless it is `next`. Call before starting `next`. */
export function claimAudioPlayback(next: HTMLMediaElement): void {
  if (playing && playing !== next) {
    playing.pause()
  }
  playing = next
}

/** Release the claim if `element` still holds it. Call on pause, end and unmount. */
export function releaseAudioPlayback(element: HTMLMediaElement): void {
  if (playing === element) playing = null
}

/** Stop playback outright — leaving a session, closing a window. */
export function stopAudioPlayback(): void {
  playing?.pause()
  playing = null
}
