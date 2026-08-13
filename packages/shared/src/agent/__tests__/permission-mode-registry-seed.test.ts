/**
 * A session's stored permission mode has to reach the registry that
 * pre-tool-use checks actually read.
 *
 * The registry is process-global and starts empty, defaulting to 'ask'. The
 * session's own mode is restored from its config file. If nothing seeds the
 * registry when an agent is created, the two disagree: the UI reads the config
 * and shows full access while every tool call still prompts, and only toggling
 * the mode by hand repairs it — until the next restart.
 *
 * SessionManager.getOrCreateAgent seeds it via agent.setPermissionMode. These
 * tests pin the behaviour that makes the seeding necessary and sufficient.
 */

import { describe, it, expect } from 'bun:test';
import {
  cleanupModeState,
  getPermissionMode,
  setPermissionMode,
} from '../mode-manager.ts';

describe('permission mode registry', () => {
  it('defaults an unseeded session to ask, whatever its config says', () => {
    const sessionId = `unseeded-${Date.now()}`;

    // Nobody registered this session — this is the state after a restart
    expect(getPermissionMode(sessionId)).toBe('ask');

    cleanupModeState(sessionId);
  });

  it('reports full access once the session mode is seeded', () => {
    const sessionId = `seeded-${Date.now()}`;

    // What agent.setPermissionMode(managed.permissionMode) does
    setPermissionMode(sessionId, 'allow-all', { changedBy: 'restore' });

    expect(getPermissionMode(sessionId)).toBe('allow-all');

    cleanupModeState(sessionId);
  });

  it('keeps sessions independent', () => {
    const open = `seeded-open-${Date.now()}`;
    const guarded = `seeded-guarded-${Date.now()}`;

    setPermissionMode(open, 'allow-all', { changedBy: 'restore' });
    setPermissionMode(guarded, 'safe', { changedBy: 'restore' });

    expect(getPermissionMode(open)).toBe('allow-all');
    expect(getPermissionMode(guarded)).toBe('safe');

    cleanupModeState(open);
    cleanupModeState(guarded);
  });

  it('forgets the mode after cleanup, so a stale entry cannot outlive a session', () => {
    const sessionId = `recycled-${Date.now()}`;

    setPermissionMode(sessionId, 'allow-all', { changedBy: 'restore' });
    expect(getPermissionMode(sessionId)).toBe('allow-all');

    cleanupModeState(sessionId);

    expect(getPermissionMode(sessionId)).toBe('ask');
    cleanupModeState(sessionId);
  });
});
