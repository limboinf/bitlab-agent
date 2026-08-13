import React from 'react'
import ReactDOM from 'react-dom/client'
import { Provider as JotaiProvider, useAtomValue } from 'jotai'
import App from './App'
import { ThemeProvider } from './context/ThemeContext'
import { windowWorkspaceIdAtom } from './atoms/sessions'
import { Toaster } from '@/components/ui/sonner'
import { setupI18n, i18n } from '@bitlab/shared/i18n'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import './index.css'

// Initialize i18n before any React rendering
setupI18n([LanguageDetector, initReactI18next])

// One-shot bootstrap: ensure the main process's i18n + preferences.json learn
// the language we just restored from localStorage. The main-process IPC handler
// validates the code and persists idempotently, so this is safe to run on every
// renderer startup. Without this push, a freshly-installed (or freshly-upgraded)
// app would still generate titles in English until the user manually re-picks
// the language in Appearance.
const resolvedLanguage = i18n.resolvedLanguage
// Diagnostic: console-log the bootstrap push so it shows up in DevTools.
// If this differs from the main-process startup log, the renderer's
// localStorage isn't tracking the user's Appearance selection.
console.info('[i18n] renderer bootstrap push', {
  resolvedLanguage: resolvedLanguage ?? null,
  localStorageI18nextLng: typeof window !== 'undefined' ? window.localStorage?.getItem('i18nextLng') : null,
})
if (resolvedLanguage) {
  void window.electronAPI?.changeLanguage?.(resolvedLanguage)
}

/**
 * Minimal fallback UI shown when the entire React tree crashes.
 */
function CrashFallback() {
  return (
    <div className="flex flex-col items-center justify-center h-screen font-sans text-foreground/50 gap-3">
      <p className="text-base font-medium">{i18n.t('crash.somethingWentWrong')}</p>
      <p className="text-[13px]">{i18n.t('crash.restartPrompt')}</p>
      <button
        onClick={() => window.location.reload()}
        className="mt-2 px-4 py-1.5 rounded-md bg-background shadow-minimal text-[13px] text-foreground/70 cursor-pointer"
      >
        {i18n.t('crash.reload')}
      </button>
    </div>
  )
}

/**
 * Root component - loads workspace ID for theme context and renders App
 * App.tsx handles window mode detection internally (main vs tab-content)
 */
function Root() {
  // Shared atom — written by App on init & workspace switch, read here for ThemeProvider
  const workspaceId = useAtomValue(windowWorkspaceIdAtom)

  return (
    <ThemeProvider activeWorkspaceId={workspaceId}>
      <App />
      <Toaster />
    </ThemeProvider>
  )
}

class RootErrorBoundary extends React.Component<{ children: React.ReactNode; fallback: React.ReactNode }, { hasError: boolean }> {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error: Error) {
    console.error('[RootErrorBoundary] App crashed:', error)
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootErrorBoundary fallback={<CrashFallback />}>
      <JotaiProvider>
        <Root />
      </JotaiProvider>
    </RootErrorBoundary>
  </React.StrictMode>
)
