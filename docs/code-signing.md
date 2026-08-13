# Code signing and notarization

Bitlab releases without any signing credentials. That mode is real and supported —
macOS builds are ad-hoc signed and Windows installers are unsigned — but users pay
for it with a Gatekeeper or SmartScreen warning on first launch, and macOS
auto-update stays disabled. This document is the path from that default to trusted
installers.

Signing is resolved per platform and all-or-nothing per platform. The
`release-policy` job fails the release if a group is only half configured, so a
typo cannot silently downgrade an intended trusted build. See
[releases.md](./releases.md) for how that decision flows through the workflow.

| Platform | Secrets group | Result when configured |
| --- | --- | --- |
| macOS | `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Developer ID signed + notarized, Hardened Runtime on, auto-update enabled |
| Windows | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Authenticode signed |
| Linux | none | AppImage is never signed; integrity comes from `SHA256SUMS` |

## macOS

### Prerequisites

- A paid **Apple Developer Program** membership (individual or organization).
  A free Apple ID cannot issue Developer ID certificates.
- A Mac with Xcode or the Xcode Command Line Tools.

The certificate type must be **Developer ID Application**. `Apple Development`
and `Mac App Distribution` certificates exist in the same account and look
similar, but neither one produces an app that Gatekeeper trusts outside the App
Store, and notarization will reject them.

### 1. Create the Developer ID Application certificate

The Xcode path is shorter and generates the private key for you:

1. Xcode → **Settings** → **Accounts** → select your Apple ID → **Manage Certificates…**
2. Click **+** → **Developer ID Application**.
3. The certificate and its private key land in your login keychain.

If you prefer the web console, or Xcode refuses because the account already has
the maximum number of certificates:

1. Open **Keychain Access** → menu **Certificate Assistant** → **Request a Certificate From a Certificate Authority…**
2. Enter your email and name, select **Saved to disk**, and save `CertificateSigningRequest.certSigningRequest`.
3. Go to [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates) → **+** → **Developer ID Application** → upload the CSR.
4. Download the resulting `.cer` and double-click it to install it into the login keychain.

Confirm the identity exists and note the ten-character Team ID in parentheses:

```bash
security find-identity -v -p codesigning
```

You want a line reading `Developer ID Application: Your Name (ABCDE12345)`.

### 2. Export the certificate as a .p12

1. **Keychain Access** → **login** keychain → **My Certificates**.
2. Find `Developer ID Application: …` and expand it — it must show a private key
   underneath. Without the private key the export is useless.
3. Right-click the certificate → **Export "Developer ID Application: …"** →
   format **Personal Information Exchange (.p12)**.
4. Set a strong password. This becomes `CSC_KEY_PASSWORD`.

### 3. Encode the .p12 for GitHub

`CSC_LINK` takes the certificate as a base64 string:

```bash
base64 -i ~/Desktop/bitlab-developer-id.p12 | pbcopy
```

Paste the clipboard into the secret. Delete the `.p12` from disk afterwards, or
move it into a password manager — it is your signing identity.

### 4. Create an app-specific password for notarization

Your real Apple ID password will not work, and an account with two-factor
authentication requires this step:

1. Sign in at [appleid.apple.com](https://appleid.apple.com).
2. **Sign-In and Security** → **App-Specific Passwords** → **+**.
3. Name it something like `bitlab-notarization` and copy the generated
   `xxxx-xxxx-xxxx-xxxx` value. It is shown once.

That value is `APPLE_APP_SPECIFIC_PASSWORD`; `APPLE_ID` is the email address of
the account that owns it.

### 5. Find the Team ID

Either read it from the parentheses in `security find-identity` output, or open
[developer.apple.com/account](https://developer.apple.com/account) →
**Membership details** → **Team ID**. It is `APPLE_TEAM_ID`.

For an organization account, the Apple ID used for notarization must belong to
that team; a personal Apple ID with its own separate team will notarize against
the wrong Team ID and fail.

### 6. Store the five secrets

In the repository: **Settings** → **Environments** → `release` → **Add secret**.
The release jobs read them from the `release` environment, not from repository
secrets, so adding them at the repository level alone has no effect.

| Secret | Value |
| --- | --- |
| `CSC_LINK` | base64 of the `.p12` |
| `CSC_KEY_PASSWORD` | the `.p12` export password |
| `APPLE_ID` | Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | the `xxxx-xxxx-xxxx-xxxx` value |
| `APPLE_TEAM_ID` | ten-character Team ID |

The next tagged release picks them up automatically: `forceCodeSigning` turns on,
Hardened Runtime stays enabled, electron-builder notarizes through `notarytool`
and staples the ticket, and `BITLAB_AUTO_UPDATE_ENABLED` becomes true for macOS.

### 7. Verify locally before spending a release on it

Signing and notarization can be rehearsed on your own machine:

```bash
bun run electron:dist:mac
codesign --verify --deep --strict --verbose=2 "apps/electron/release/mac-arm64/Bitlab.app"
spctl --assess --type execute --verbose "apps/electron/release/mac-arm64/Bitlab.app"
xcrun stapler validate "apps/electron/release/Bitlab-0.1.0-arm64.dmg"
```

`spctl` should report `accepted` and `source=Notarized Developer ID`. Anything
mentioning `rejected` or `source=Unnotarized Developer ID` means the ticket was
not stapled.

For notarization to run locally you need the same Apple credentials exported in
your shell:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="ABCDE12345"
```

Notarization is a network round-trip to Apple and typically takes 2–15 minutes
per artifact. A release builds four macOS artifacts (two DMG, two ZIP), so budget
accordingly against the workflow's 120-minute job timeout.

### Common failures

| Symptom | Cause |
| --- | --- |
| `No identity found` in CI | `CSC_LINK` is not valid base64, or the `.p12` was exported without its private key |
| `The specified item could not be found in the keychain` | wrong `CSC_KEY_PASSWORD` |
| Notarization returns `Invalid` with `The signature does not include a secure timestamp` | Hardened Runtime or timestamping was disabled; do not pass `-c.mac.hardenedRuntime=false` on a signed build |
| Notarization returns `Invalid` with `Team is not yet configured for notarization` | the Apple ID is not a member of the team owning the certificate |
| App still shows "damaged and can't be opened" after signing | the ticket was not stapled; check `xcrun stapler validate` |

## Windows

Windows is harder than macOS now, and not because of the workflow. Since June
2023 the CA/Browser Forum requires code-signing private keys to live on
FIPS-140-2 hardware — a USB token or a cloud HSM. A plain exportable `.pfx` for
`WIN_CSC_LINK` is no longer something a certificate authority will issue for a
new OV or EV certificate, so the two Windows secrets only work if you already
hold a legacy exportable certificate.

Realistic options:

- **Ship unsigned.** SmartScreen shows a warning that users dismiss through
  **More info** → **Run anyway**. Reputation accumulates with download volume and
  the warning eventually stops for that binary. This is the current default.
- **[Azure Trusted Signing](https://learn.microsoft.com/azure/trusted-signing/)** —
  Microsoft's managed signing service, roughly $10/month, no hardware token.
  Requires a verified legal identity and, for organizations, three years of
  business history. It needs a different electron-builder configuration than
  `WIN_CSC_LINK`; wire it as a custom `sign` hook.
- **[SignPath Foundation](https://signpath.org/)** — free certificates and signing
  infrastructure for OSS projects that meet its criteria.

If you do hold an exportable `.pfx`, the encoding is the same as macOS:

```bash
base64 -i certificate.pfx | pbcopy
```

Store it as `WIN_CSC_LINK` and its password as `WIN_CSC_KEY_PASSWORD` in the
`release` environment. The workflow then adds `forceCodeSigning` and verifies
every produced `.exe` with `Get-AuthenticodeSignature`.

## What users do with unsigned builds

Keep these instructions in the release notes for as long as builds are unsigned.

macOS refuses an ad-hoc-signed app with "Bitlab is damaged and can't be opened".
The quarantine attribute, not the app, is the problem:

```bash
xattr -dr com.apple.quarantine /Applications/Bitlab.app
```

Windows SmartScreen: **More info** → **Run anyway**.

Both cases are worth pairing with the `SHA256SUMS` file published on every
release, so a cautious user can verify the download instead of trusting the
warning dialog:

```bash
shasum -a 256 -c SHA256SUMS --ignore-missing
```
