#!/usr/bin/env bun

import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";

export const PROVENANCE_FILE = "BUILD_PROVENANCE.json";
const CHECKSUM_FILE = "SHA256SUMS";

export interface ReleaseProvenance {
  schemaVersion: 1;
  tag: string;
  version: string;
  commitSha: string;
  workflowRunId: string;
  workflowRunAttempt: number;
  macSigning: boolean;
  windowsSigning: boolean;
  builtAt: string;
}

function fail(message: string): never {
  throw new Error(`release candidate: ${message}`);
}

function normalizeTag(tag: string): string {
  if (!/^v\d+\.\d+\.\d+$/.test(tag))
    fail(`expected a stable v<major>.<minor>.<patch> tag, received ${tag}`);
  return tag;
}

function normalizeSha(sha: string): string {
  if (!/^[0-9a-f]{40}$/.test(sha))
    fail(`expected a full lowercase commit SHA, received ${sha}`);
  return sha;
}

function parseBoolean(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return fail(`${name} must be true or false, received ${value}`);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseChecksums(directory: string): Map<string, string> {
  const path = join(directory, CHECKSUM_FILE);
  if (!existsSync(path)) fail(`${CHECKSUM_FILE} is missing`);

  const result = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").trim().split("\n")) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) fail(`invalid checksum line: ${line}`);
    const [, digest, name] = match;
    if (!name || name !== basename(name) || name === CHECKSUM_FILE)
      fail(`unsafe checksum path: ${name ?? "<missing>"}`);
    if (result.has(name)) fail(`duplicate checksum entry: ${name}`);
    result.set(name, digest!);
  }
  return result;
}

function requiredAssets(version: string): string[] {
  return [
    `Bitlab-${version}-arm64.dmg`,
    `Bitlab-${version}-arm64.zip`,
    `Bitlab-${version}-x64.dmg`,
    `Bitlab-${version}-x64.zip`,
    `Bitlab-${version}-x64.exe`,
    `Bitlab-${version}-x86_64.AppImage`,
    `Bitlab-server-${version}-darwin-arm64.tar.gz`,
    `Bitlab-server-${version}-darwin-x64.tar.gz`,
    `Bitlab-server-${version}-linux-x64.tar.gz`,
    `Bitlab-server-${version}-win32-x64.zip`,
    "latest-mac.yml",
    "latest.yml",
    "latest-linux.yml",
    "SIGNING_STATUS.txt",
    PROVENANCE_FILE,
  ];
}

function requireAssets(checksums: Map<string, string>, version: string): void {
  for (const name of requiredAssets(version)) {
    if (!checksums.has(name)) fail(`missing required release asset: ${name}`);
  }
}

function readProvenance(directory: string): ReleaseProvenance {
  const path = join(directory, PROVENANCE_FILE);
  if (!existsSync(path)) fail(`${PROVENANCE_FILE} is missing`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fail(`${PROVENANCE_FILE} is not valid JSON`);
  }
  if (!value || typeof value !== "object")
    fail(`${PROVENANCE_FILE} must contain an object`);
  const provenance = value as Partial<ReleaseProvenance>;
  if (provenance.schemaVersion !== 1) fail("unsupported provenance schema");
  normalizeTag(provenance.tag ?? "");
  normalizeSha(provenance.commitSha ?? "");
  if (provenance.version !== provenance.tag!.slice(1))
    fail("provenance tag and version disagree");
  if (!/^\d+$/.test(provenance.workflowRunId ?? ""))
    fail("provenance workflowRunId is invalid");
  if (
    !Number.isInteger(provenance.workflowRunAttempt) ||
    provenance.workflowRunAttempt! < 1
  )
    fail("provenance workflowRunAttempt is invalid");
  if (typeof provenance.macSigning !== "boolean")
    fail("provenance macSigning is invalid");
  if (typeof provenance.windowsSigning !== "boolean")
    fail("provenance windowsSigning is invalid");
  if (
    typeof provenance.builtAt !== "string" ||
    Number.isNaN(Date.parse(provenance.builtAt))
  )
    fail("provenance builtAt is invalid");
  return provenance as ReleaseProvenance;
}

function verifyChecksums(directory: string): Map<string, string> {
  const checksums = parseChecksums(directory);
  for (const [name, expected] of checksums) {
    const path = join(directory, name);
    if (!existsSync(path)) fail(`checksummed asset is missing: ${name}`);
    const actual = sha256(path);
    if (actual !== expected) fail(`checksum mismatch for ${name}`);
  }

  const actualFiles = readdirSync(directory).sort();
  const expectedFiles = [...checksums.keys(), CHECKSUM_FILE].sort();
  if (actualFiles.join("\n") !== expectedFiles.join("\n")) {
    const unexpected = actualFiles.filter((name) => !expectedFiles.includes(name));
    const missing = expectedFiles.filter((name) => !actualFiles.includes(name));
    fail(
      `candidate file set does not match ${CHECKSUM_FILE}; ` +
        `unexpected: ${unexpected.join(", ") || "none"}; ` +
        `missing: ${missing.join(", ") || "none"}`,
    );
  }
  return checksums;
}

export function createCandidate(
  directory: string,
  tagInput: string,
  shaInput: string,
  workflowRunId: string,
  workflowRunAttemptInput: string,
  macSigningInput: string,
  windowsSigningInput: string,
): void {
  const tag = normalizeTag(tagInput);
  const commitSha = normalizeSha(shaInput);
  if (!/^\d+$/.test(workflowRunId)) fail("workflow run ID must be numeric");
  const workflowRunAttempt = Number(workflowRunAttemptInput);
  if (!Number.isInteger(workflowRunAttempt) || workflowRunAttempt < 1)
    fail("workflow run attempt must be a positive integer");
  if (existsSync(join(directory, PROVENANCE_FILE)))
    fail(`${PROVENANCE_FILE} already exists`);

  const existingChecksums = verifyChecksums(directory);
  for (const name of requiredAssets(tag.slice(1))) {
    if (name !== PROVENANCE_FILE && !existingChecksums.has(name))
      fail(`missing required release asset: ${name}`);
  }
  const provenance: ReleaseProvenance = {
    schemaVersion: 1,
    tag,
    version: tag.slice(1),
    commitSha,
    workflowRunId,
    workflowRunAttempt,
    macSigning: parseBoolean(macSigningInput, "mac signing"),
    windowsSigning: parseBoolean(windowsSigningInput, "windows signing"),
    builtAt: new Date().toISOString(),
  };
  const provenancePath = join(directory, PROVENANCE_FILE);
  writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  writeFileSync(
    join(directory, CHECKSUM_FILE),
    `${readFileSync(join(directory, CHECKSUM_FILE), "utf8").trimEnd()}\n` +
      `${sha256(provenancePath)}  ${PROVENANCE_FILE}\n`,
  );
  console.log(`Created release candidate ${tag} for ${commitSha}`);
}

export function verifyCandidate(
  directory: string,
  expectedTagInput: string,
  expectedShaInput: string,
  expectedRunId?: string,
): ReleaseProvenance {
  const expectedTag = normalizeTag(expectedTagInput);
  const expectedSha = normalizeSha(expectedShaInput);
  const provenance = readProvenance(directory);
  if (provenance.tag !== expectedTag)
    fail(`expected tag ${expectedTag}, found ${provenance.tag}`);
  if (provenance.commitSha !== expectedSha)
    fail(`expected commit ${expectedSha}, found ${provenance.commitSha}`);
  if (expectedRunId && provenance.workflowRunId !== expectedRunId)
    fail(
      `expected workflow run ${expectedRunId}, found ${provenance.workflowRunId}`,
    );

  const checksums = verifyChecksums(directory);
  requireAssets(checksums, provenance.version);
  console.log(
    `Verified release candidate ${provenance.tag} from workflow run ${provenance.workflowRunId}`,
  );
  return provenance;
}

if (import.meta.main) {
  const [command, directory, tag, sha, runId, attempt, macSigning, windowsSigning] =
    Bun.argv.slice(2);
  if (command === "create" && directory && tag && sha && runId && attempt && macSigning && windowsSigning) {
    createCandidate(directory, tag, sha, runId, attempt, macSigning, windowsSigning);
  } else if (command === "verify" && directory && tag && sha) {
    verifyCandidate(directory, tag, sha, runId);
  } else {
    fail(
      "usage: release-candidate.ts create <dir> <tag> <sha> <run-id> <attempt> <mac-signing> <windows-signing> | verify <dir> <tag> <sha> [run-id]",
    );
  }
}
