// electron-builder calls this for every Windows file it signs (build.win.signtoolOptions.sign).
// The signing client and the login come from .github/actions/windows-signing.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

module.exports = async function sign(configuration) {
  if (!process.env.ARTIFACT_SIGNING_DLIB) {
    if (process.env.CI) throw new Error('Code signing is not prepared (.github/actions/windows-signing)')
    console.log(`  • not signed, no signing setup: ${configuration.path}`)
    return
  }
  const script = path.join(__dirname, '..', '.github', 'actions', 'windows-signing', 'sign.ps1')
  execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script, configuration.path], { stdio: 'inherit' })
}
