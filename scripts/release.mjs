// Build the installer for the version in package.json and publish it as a GitHub release.
// Installed copies of quickMail find it through latest.yml and update themselves.
// Usage: bump "version" in package.json, commit and push, then: npm run release
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' })

run('npm', ['run', 'dist'])
const files = [`release/quickMail-Setup-${version}.exe`, `release/quickMail-Setup-${version}.exe.blockmap`, 'release/latest.yml']
for (const f of files) if (!fs.existsSync(f)) throw new Error(`Missing ${f}`)
run('gh', ['release', 'create', `v${version}`, ...files, '--title', `"quickMail ${version}"`, '--generate-notes'])
