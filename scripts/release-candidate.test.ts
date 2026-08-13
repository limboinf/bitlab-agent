import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  createCandidate,
  PROVENANCE_FILE,
  verifyCandidate,
} from "./release-candidate";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(version = "1.2.3"): string {
  const root = mkdtempSync(join(tmpdir(), "bitlab-release-candidate-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  const names = [
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
  ];
  for (const name of names) writeFileSync(join(root, name), `fixture:${name}\n`);
  const checksums = names
    .sort()
    .map(
      (name) =>
        `${createHash("sha256").update(readFileSync(join(root, name))).digest("hex")}  ${name}`,
    )
    .join("\n");
  writeFileSync(join(root, "SHA256SUMS"), `${checksums}\n`);
  return root;
}

describe("release candidate provenance", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";

  it("creates and verifies a candidate bound to an exact tag and commit", () => {
    const root = fixture();
    createCandidate(root, "v1.2.3", sha, "12345", "2", "true", "false");

    const provenance = verifyCandidate(root, "v1.2.3", sha);
    expect(provenance).toMatchObject({
      schemaVersion: 1,
      tag: "v1.2.3",
      version: "1.2.3",
      commitSha: sha,
      workflowRunId: "12345",
      workflowRunAttempt: 2,
      macSigning: true,
      windowsSigning: false,
    });
    expect(readFileSync(join(root, "SHA256SUMS"), "utf8")).toContain(
      `  ${PROVENANCE_FILE}`,
    );
  });

  it("rejects promotion from another commit", () => {
    const root = fixture();
    createCandidate(root, "v1.2.3", sha, "12345", "1", "true", "false");

    expect(() =>
      verifyCandidate(root, "v1.2.3", "fedcba9876543210fedcba9876543210fedcba98"),
    ).toThrow("expected commit");
  });

  it("rejects promotion under another tag", () => {
    const root = fixture();
    createCandidate(root, "v1.2.3", sha, "12345", "1", "true", "false");

    expect(() => verifyCandidate(root, "v1.2.4", sha)).toThrow("expected tag");
  });

  it("rejects an artifact copied from another workflow run", () => {
    const root = fixture();
    createCandidate(root, "v1.2.3", sha, "12345", "1", "true", "false");

    expect(() => verifyCandidate(root, "v1.2.3", sha, "54321")).toThrow(
      "expected workflow run",
    );
  });

  it("rejects a candidate whose asset changed after verification", () => {
    const root = fixture();
    createCandidate(root, "v1.2.3", sha, "12345", "1", "true", "false");
    writeFileSync(join(root, "Bitlab-1.2.3-x64.exe"), "tampered\n");

    expect(() => verifyCandidate(root, "v1.2.3", sha)).toThrow(
      "checksum mismatch",
    );
  });

  it("rejects unchecksummed files", () => {
    const root = fixture();
    writeFileSync(join(root, "surprise.txt"), "not checksummed\n");

    expect(() =>
      createCandidate(root, "v1.2.3", sha, "12345", "1", "true", "false"),
    ).toThrow("candidate file set does not match");
  });
});
