// Try Qmail with made-up mail: builds if needed, seeds ./demo-store, and starts the app in demo mode.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const home = path.resolve('demo-store')
const env = { ...process.env, QUICKMAIL_HOME: home, QUICKMAIL_DEMO: '1' }
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' })

if (!fs.existsSync('out/main/index.js') || !fs.existsSync('dist/cli.mjs')) run('npm', ['run', 'build'])
run('node', ['dist/cli.mjs', 'accounts']) // creates the empty store
run('node', ['scripts/seed-demo.mjs'])
run('npx', ['electron', '.', `--user-data-dir=${path.join(home, 'profile')}`])
