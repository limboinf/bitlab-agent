# Releases, updates, and telemetry

Release candidates in the open-source repository build macOS DMG/ZIP, Windows NSIS, Linux AppImage, and the headless server for each platform; a matching annotated tag promotes those exact verified assets. Source code and downloadable artifacts live together in [limboinf/bitlab-agent](https://github.com/limboinf/bitlab-agent/releases/latest). Signing credentials are optional: a zero-secret candidate produces ad-hoc-signed macOS packages and unsigned Windows installers, while complete platform credentials automatically enable Apple Developer ID signing/notarization or Windows Authenticode.

## Release pipeline

```text
  main ──▶ release:prepare ──▶ reviewed version commit
                                      │
                                      ▼
                        manual Release candidate run
                   ┌──────────────────┴──────────────────┐
                   ▼                                     ▼
          validation and tests                 four platform builds
                                               + signing/notarization
                   └──────────────────┬──────────────────┘
                                      ▼
                    checksummed candidate bound to commit SHA
                                      │
                                      ▼
                         annotated v* tag on the same commit
                                      │
                                      ▼
                    verify provenance and publish without rebuilding
```

Installers, manifest files (for example `latest-mac.yml`, `latest.yml`, and `latest-linux.yml`), blockmaps, checksums, and release notes live in the main repository's GitHub Releases rather than being committed to Git. A separate release-only repository is no longer used.

Pull requests and pushes to `main` run the unsigned packaging matrix for macOS arm64, Windows x64, and Linux x64. Those validation packages and matching headless-server archives are retained as GitHub Actions artifacts for 7 days. A manual Release workflow run builds the complete release candidate once, applying the configured signing policy, and retains it for 30 days. Only a reviewed `v*` tag on that exact candidate commit promotes the verified asset matrix to a durable GitHub Release; the tag workflow verifies provenance and checksums instead of rebuilding every platform.

## Version and changelog policy

Bitlab uses semantic versions and `v<major>.<minor>.<patch>` Git tags. [`CHANGELOG.md`](../CHANGELOG.md) is the canonical cumulative changelog. The tag workflow extracts the matching version section for the public GitHub Release.

Prepare a release only from a clean `main` branch:

```bash
# First replace the Unreleased placeholder in CHANGELOG.md with real entries.
bun run release:prepare 0.2.0
bun run release:check v0.2.0
git diff --check
git add CHANGELOG.md package.json bun.lock apps/*/package.json packages/*/package.json
git commit -m "chore(release): prepare v0.2.0"
git push origin main
```

`release:prepare` updates every workspace package version, refreshes `bun.lock`, and moves the Unreleased changelog entries into a dated version section. After pushing the reviewed commit, run **Actions** → **Release** → **Run workflow** with `v0.2.0`. Once that candidate succeeds, tag the same commit:

```bash
git tag -a v0.2.0 -m "Bitlab v0.2.0"
git push origin v0.2.0
```

The tag workflow independently rejects missing or inconsistent metadata, a candidate from another commit or workflow run, expired assets, and any checksum mismatch.

### The first release

`release:prepare` requires the new version to be strictly greater than the one in `package.json`. Every manifest already reads `0.1.0`, so preparing `0.1.0` is rejected by design — there is nothing to bump. For the first release, verify and push the existing version commit, build its candidate, then tag that same commit:

```bash
# CHANGELOG.md already carries a dated [0.1.0] section.
bun run release:check v0.1.0
git push origin main
# Run Actions → Release with tag v0.1.0 and wait for the candidate to succeed.
git tag -a v0.1.0 -m "Bitlab v0.1.0"
git push origin v0.1.0
```

Every release after that goes through `release:prepare`.

### Building and promoting a release candidate

The expensive work happens once, before the tag exists. Use **Actions** → **Release** → **Run workflow** and enter the intended stable tag. The workflow performs the lightweight version preflight first, then runs validation and the four-platform build matrix in parallel. Complete platform credentials enable signing automatically; macOS signing and notarization remain part of the candidate build.

The collected candidate contains installers, headless-server bundles, manifests, signing status, `SHA256SUMS`, and `BUILD_PROVENANCE.json`. It is named with the intended tag and full commit SHA and retained for 30 days. No Release is published yet.

Push the annotated tag only after reviewing the successful candidate. The tag workflow locates the exact candidate by tag and SHA, verifies that it came from a successful manual run of this Release workflow, rechecks provenance and every checksum, and then publishes it as Latest. It does not rebuild. A tag without an exact unexpired candidate fails with instructions to build one; it never silently falls back to a different run.

## Installer matrix

| Platform                   | Build                    | Naming                             | Signing                               | Notes                                                                                  |
| -------------------------- | ------------------------ | ---------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------- |
| macOS arm64                | DMG + ZIP                | `Bitlab-0.1.0-arm64.{dmg,zip}`    | ad-hoc or Developer ID + notarization  | no-certificate builds disable Hardened Runtime and require manual updates              |
| macOS x64                  | DMG + ZIP                | `Bitlab-0.1.0-x64.{dmg,zip}`      | same                                    | for Intel Macs                                                                         |
| Windows x64                | NSIS                     | `Bitlab-0.1.0-x64.exe`            | unsigned or Authenticode                | unsigned builds may trigger SmartScreen; per-user install under `%LOCALAPPDATA%\Programs\` |
| Linux x64                  | AppImage                 | `Bitlab-0.1.0-x86_64.AppImage`    | none                                  | electron-builder renders `x64` as `x86_64` for AppImage; desktop category: Utility     |
| Headless server (per-arch) | `bun build --compile`    | `bitlab-server-<platform>-<arch>` | none                                  | consumed by WebUI and external RPC clients                                            |

`bun run electron:dist:dev:mac` produces a local ad-hoc-signed build and disables automatic updates. Release jobs also set `CSC_IDENTITY_AUTO_DISCOVERY=false`, `mac.identity=-`, and `hardenedRuntime=false` explicitly when Apple credentials are absent. Ad-hoc signing satisfies Apple Silicon code-integrity requirements but does not establish a trusted developer identity, so Gatekeeper warnings remain.

## Updates

The Electron app uses `electron-updater` against the GitHub Releases API on `limboinf/bitlab-agent`. The public repository and its update manifests require no client-side GitHub token.

| Field        | Where it is set                                              |
| ------------ | ------------------------------------------------------------ |
| `appId`      | `apps/electron/electron-builder.yml` → `app.bitlab.desktop` |
| Provider     | `github`                                                     |
| Owner / repo | `limboinf` / `bitlab-agent`                                     |
| Manifest     | auto-generated by electron-builder at release time           |

When a downgrade is required, the user must install an older build manually; auto-update only moves forward.

macOS automatic updates require a Developer ID-signed application. Ad-hoc macOS builds therefore skip startup update checks and reject manual in-app update attempts with a link to the latest GitHub Release. Users update those builds by downloading the next DMG manually. Windows and Linux continue to use their normal updater targets.

## Cross-builder reproducibility

The `electron-builder.yml` `files` / `extraResources` blocks are first-class artifacts of the Lite boundary. They are what give Bitlab its smaller installer footprint; see [`comparison-with-craft.md`](./comparison-with-craft.md) for the concrete numbers. Any release-time change to either block must update both that document and `appId` / `productName` / `copyright` at the top of the same file.

## GitHub release environment

The workflow works with no signing secrets. To enable trusted platform builds, create a protected Actions environment named `release` and configure one complete credential group:

| Secret                                                     | Purpose                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `CSC_LINK`, `CSC_KEY_PASSWORD`                             | Developer ID certificate and password; must be paired with all Apple fields            |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Apple notarization; all five Apple secrets enable signed/notarized macOS builds         |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`                     | Both secrets enable Windows Authenticode                                                |

[code-signing.md](./code-signing.md) walks through creating a Developer ID Application certificate, exporting it, and encoding it for these secrets, plus what to do about Windows now that code-signing keys must live on hardware.

Missing credential groups select the no-certificate mode: ad-hoc signing on macOS and unsigned Windows installers. Partially configured groups fail before builds start so a typo cannot silently downgrade an intended trusted release. Every Release records the resolved platform trust modes in its notes and `SIGNING_STATUS.txt`; that file is also covered by `SHA256SUMS`. The candidate workflow uses read-only repository permissions and signs only inside the protected `release` environment. The tag promotion job receives `actions: read` and `contents: write`, creates a draft release, uploads the exact verified candidate, and only then publishes it as Latest. Re-running a failed promotion may update an existing draft, but it will not overwrite an already published release.

## Pre-release checklist

```bash
git status --short                # clean working tree
git log -n 5 --oneline            # cross-check the version bump and its commit
bun run release:check v0.2.0
bun run audit:brand
bun run validate:ci
bun run typecheck:all
bun run test
bun run electron:build
bun run webui:build
bun run server:build:subprocess
```

Run the Release candidate workflow on that exact commit after the checklist passes. Before building the candidate, either configure each desired signing group completely or leave that entire group empty for a deliberate unsigned release. Create the tag only after the candidate succeeds.
