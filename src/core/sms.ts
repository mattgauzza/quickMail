import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * Experimental: read text messages from an Android phone connected over USB (or wireless adb)
 * with USB debugging on. Read-only; sending goes through the Messages tab in the app.
 */
export async function listSms(limit = 30, from?: string) {
  let out: string
  try {
    const args = ['shell', 'content', 'query', '--uri', 'content://sms', '--projection', 'address:date:type:read:body', '--sort', `'date DESC LIMIT ${Math.floor(limit)}'`]
    if (from) args.push('--where', `"address LIKE '%${from.replace(/[^\d+]/g, '')}%'"`)
    out = (await exec('adb', args, { maxBuffer: 32 * 1024 * 1024 })).stdout
  } catch (e: any) {
    const msg = String(e.stderr || e.message)
    if (/no devices|not found|ENOENT/i.test(msg))
      throw new Error('No Android phone reachable over adb. Plug it in with USB debugging enabled (and adb on PATH).')
    throw new Error(`adb: ${msg.trim()}`)
  }
  return out
    .split(/^Row: \d+ /m)
    .map(r => r.match(/^address=(.*?), date=(\d+), type=(\d+), read=(\d+), body=([\s\S]*)$/))
    .filter(m => !!m)
    .map(m => ({
      address: m[1], date: Number(m[2]), direction: m[3] === '1' ? 'in' : 'out', unread: m[4] === '0', body: m[5].trimEnd()
    }))
}
