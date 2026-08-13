/** Documentation links and summaries for retained settings and features. */

const DOCS_TREE_URL = 'https://github.com/limboinf/bitlab-agent/tree/main/docs';
const DOCS_BLOB_URL = 'https://github.com/limboinf/bitlab-agent/blob/main/docs';

export type DocFeature =
  | 'skills'
  | 'permissions'
  | 'workspaces'
  | 'themes'
  | 'app-settings'
  | 'preferences'
  | 'browser'
  | 'documents';

export interface DocInfo {
  /** Markdown file under `docs/`. Omitted when no dedicated page exists yet. */
  file?: string;
  title: string;
  summary: string;
}

export const DOCS: Record<DocFeature, DocInfo> = {
  skills: {
    file: 'skills.md',
    title: 'Skills',
    summary: 'Create and use reusable SKILL.md instruction sets.',
  },
  permissions: {
    file: 'permissions.md',
    title: 'Permissions',
    summary: 'Control Explore, Ask, and Execute behavior.',
  },
  workspaces: {
    file: 'workspaces.md',
    title: 'Workspaces',
    summary: 'Keep sessions, Skills, permissions, and settings isolated.',
  },
  themes: {
    title: 'Themes',
    summary: 'Configure light, dark, system, and preset themes.',
  },
  'app-settings': {
    title: 'App Settings',
    summary: 'Configure connections, models, proxy, language, and updates.',
  },
  preferences: {
    title: 'Preferences',
    summary: 'Personalize agent responses with workspace preferences.',
  },
  browser: {
    file: 'browser.md',
    title: 'Browser',
    summary: 'Use the built-in browser and browser_tool safely.',
  },
  documents: {
    file: 'document-tools.md',
    title: 'Document Tools',
    summary: 'Read, convert, compare, and render supported document formats.',
  },
};

/**
 * Public URL for a feature's documentation. Features without a dedicated page
 * fall back to the repository's `docs/` index.
 */
export function getDocUrl(feature: DocFeature): string {
  const { file } = DOCS[feature];
  return file ? `${DOCS_BLOB_URL}/${file}` : DOCS_TREE_URL;
}

export function getDocInfo(feature: DocFeature): DocInfo {
  return DOCS[feature];
}
