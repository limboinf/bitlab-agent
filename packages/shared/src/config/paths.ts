/**
 * Centralized path configuration for Bitlab.
 *
 * Supports multi-instance development via BITLAB_CONFIG_DIR environment variable.
 * When running from a numbered development folder, the instance detector
 * script sets BITLAB_CONFIG_DIR to ~/.bitlab-1, allowing multiple instances to run
 * simultaneously with separate configurations.
 *
 * Default (non-numbered folders): ~/.bitlab/
 * Instance 1 (-1 suffix): ~/.bitlab-1/
 * Instance 2 (-2 suffix): ~/.bitlab-2/
 */

import { homedir } from 'os';
import { join } from 'path';

export function getConfigDir(): string {
  return process.env.BITLAB_CONFIG_DIR || join(homedir(), '.bitlab');
}

// Allow override via environment variable for multi-instance dev
// Falls back to default ~/.bitlab/ for production and non-numbered dev folders
export const CONFIG_DIR = getConfigDir();
