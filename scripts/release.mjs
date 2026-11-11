// Publish the version in package.json: tags the current commit and pushes the tag.
// GitHub Actions (.github/workflows/release.yml) then builds the Windows, macOS and Linux
// installers and attaches them to the release; installed copies update themselves from it.
// Usage: bump "version" in package.json, commit and push, then: npm run release
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

if (git('status', '--porcelain')) throw new Error('Commit your changes first')
git('push', 'origin', 'HEAD')
git('tag', `v${version}`)
git('push', 'origin', `v${version}`)
console.log(`Tagged v${version}. Watch the build with: gh run watch`)
