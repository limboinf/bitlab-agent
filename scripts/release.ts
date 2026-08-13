#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";

const root = join(import.meta.dir, "..");
const changelogPath = join(root, "CHANGELOG.md");

function fail(message: string): never {
  console.error(`release: ${message}`);
  process.exit(1);
}

function normalizeVersion(input: string | undefined): string {
  const version = input?.replace(/^v/, "");
  if (!version || !semver.valid(version))
    fail(
      `expected a stable semantic version, received ${input ?? "<missing>"}`,
    );
  if (semver.prerelease(version))
    fail(
      `pre-release versions are not supported by the stable release workflow: ${version}`,
    );
  return version;
}

function manifestPaths(): string[] {
  const paths = [join(root, "package.json")];
  for (const directory of ["apps", "packages"]) {
    const base = join(root, directory);
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(base, entry.name, "package.json");
      if (existsSync(path)) paths.push(path);
    }
  }
  return paths.sort();
}

function readManifest(path: string): {
  version?: string;
  [key: string]: unknown;
} {
  return JSON.parse(readFileSync(path, "utf8"));
}

function releaseSection(changelog: string, heading: string): string | null {
  const start = changelog.indexOf(heading);
  if (start < 0) return null;
  const contentStart = start + heading.length;
  const next = changelog.indexOf("\n## [", contentStart);
  return changelog
    .slice(contentStart, next < 0 ? changelog.length : next)
    .trim();
}

function check(input: string | undefined): void {
  const version = normalizeVersion(
    input ?? readManifest(join(root, "package.json")).version,
  );
  const expectedTag = `v${version}`;
  if (input && input !== version && input !== expectedTag)
    fail(`tag must be ${expectedTag}, received ${input}`);

  const mismatches = manifestPaths()
    .map((path) => ({
      path: path.slice(root.length + 1),
      version: readManifest(path).version,
    }))
    .filter((item) => item.version !== version);
  if (mismatches.length > 0) {
    fail(
      `workspace versions must all equal ${version}:\n${mismatches.map((item) => `  ${item.path}: ${item.version}`).join("\n")}`,
    );
  }

  const changelog = readFileSync(changelogPath, "utf8");
  const headingPattern = new RegExp(
    `^## \\[${version.replaceAll(".", "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`,
    "m",
  );
  if (!headingPattern.test(changelog))
    fail(`CHANGELOG.md has no dated [${version}] section`);

  console.log(`Release metadata is consistent for ${expectedTag}`);
}

function prepare(input: string | undefined): void {
  const version = normalizeVersion(input);
  const manifests = manifestPaths();
  const currentVersion = normalizeVersion(
    readManifest(join(root, "package.json")).version,
  );
  if (!semver.gt(version, currentVersion))
    fail(
      `${version} must be greater than the current version ${currentVersion}`,
    );

  const changelog = readFileSync(changelogPath, "utf8");
  const unreleasedHeading = "## [Unreleased]";
  const unreleased = releaseSection(changelog, unreleasedHeading);
  if (!unreleased || unreleased.includes("Add user-visible changes here")) {
    fail(
      "replace the Unreleased placeholder with user-visible changes before preparing a release",
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const nextHeadingIndex = changelog.indexOf(
    "\n## [",
    changelog.indexOf(unreleasedHeading) + unreleasedHeading.length,
  );
  if (nextHeadingIndex < 0)
    fail("CHANGELOG.md must contain at least one released version");
  let nextChangelog = `${changelog.slice(0, changelog.indexOf(unreleasedHeading))}${unreleasedHeading}\n\n${unreleasedHeading.includes("placeholder") ? "" : "Add user-visible changes here before running `bun run release:prepare <version>`.\n"}\n## [${version}] - ${today}\n\n${unreleased}\n${changelog.slice(nextHeadingIndex)}`;
  nextChangelog = nextChangelog.replace(
    /^\[Unreleased\]:.*$/m,
    `[Unreleased]: https://github.com/limboinf/bitlab-agent/releases\n[${version}]: https://github.com/limboinf/bitlab-agent/releases/tag/v${version}`,
  );

  for (const path of manifests) {
    const manifest = readManifest(path);
    manifest.version = version;
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  writeFileSync(changelogPath, nextChangelog);

  const install = Bun.spawnSync(["bun", "install", "--lockfile-only"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (install.exitCode !== 0)
    fail(
      "bun install --lockfile-only failed; inspect package manifests and bun.lock",
    );

  check(version);
  console.log(
    `Prepared ${version}. Review the diff, commit it, then create and push annotated tag v${version}.`,
  );
}

const [command, version] = Bun.argv.slice(2);
if (command === "check") check(version);
else if (command === "prepare") prepare(version);
else fail("usage: bun run scripts/release.ts <prepare|check> [version-or-tag]");
