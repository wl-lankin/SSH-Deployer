# Code signing (Windows)

The Windows app and installer (installer and portable build) are Authenticode-signed with [Azure Artifact Signing](https://learn.microsoft.com/azure/artifact-signing/) (formerly Trusted Signing). The certificate names "Wolfgang Linz" as publisher; Microsoft validated the identity.

## Azure

- Resource group `code-signing`, account `wolfganglinz-signing` (North Europe, endpoint `https://neu.codesigning.azure.net`), certificate profile `wolfganglinz-public` (Public Trust). Its certificates live only a few days and are renewed by Azure; the timestamp keeps a signature valid after that.
- App registration `github-code-signing` with the role "Artifact Signing Certificate Profile Signer" on the account only. It has no secret: a federated credential trusts GitHub OIDC tokens for `repo:wl-lankin@27097016/SSH-Deployer@1241770450:environment:release`.

## GitHub

- Environment `release`; the release workflow's build jobs and the check workflow run in it.
- Repository variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` (ids, not secrets).
- `.github/actions/windows-signing` downloads Microsoft's signing client (pinned version and SHA-256) and writes its `metadata.json`. `sign.ps1` fetches a fresh OIDC token for every file and runs `signtool` with the client's dlib.
- electron-builder calls `scripts/sign-windows.cjs` for every file it signs (`build.win.signtoolOptions.sign`), which hands over to `sign.ps1`. Without the setup step the build fails in CI; locally it stays unsigned.
- `windows-signing-check.yml` builds and signs without releasing and checks the signatures. It runs on pull requests that touch the signing setup, or by hand.

## Notes

- SmartScreen reputation: a signed installer can still warn for a while until the certificate has built up reputation; the publisher name shows instead of "Unknown publisher".
- macOS and Linux builds are not signed.
