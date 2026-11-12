import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BrowserWindow, type UtilityProcess, app, dialog, ipcMain, nativeImage, nativeTheme, session, shell, utilityProcess } from 'electron'
import { autoUpdater } from 'electron-updater'

let win: BrowserWindow | null = null
const ICON = path.join(__dirname, '../../resources/icon.png')
app.setAppUserModelId('app.quickmail.desktop') // own taskbar button and icon, not Electron's
// The app used to be called quickMail. Its settings folder keeps that name, so the choices people made come along.
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', path.join(app.getPath('appData'), 'quickMail'))

// Version that is downloaded and waiting for a restart. QUICKMAIL_FAKE_UPDATE shows the button when testing the UI.
let updateReady = process.env.QUICKMAIL_FAKE_UPDATE || ''

/**
 * Installed copies keep themselves current from the project's GitHub releases: check at start and
 * every half hour, download in the background, then offer a restart (the button in the top bar).
 * An update left waiting is installed the next time the app is closed.
 */
function watchForUpdates() {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', info => {
    updateReady = info.version
    win?.webContents.send('update', updateReady)
  })
  autoUpdater.on('error', () => {}) // offline, or GitHub unreachable: try again at the next check
  const check = () => autoUpdater.checkForUpdates().catch(() => {})
  check()
  setInterval(check, 30 * 60_000)
}

/** Removes a launcher this app wrote under a name it no longer uses. A file of that name from anything else is left alone. */
function dropOldLauncher(file: string) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    if (text.includes('ELECTRON_RUN_AS_NODE') && text.includes('cli.mjs')) fs.unlinkSync(file)
  } catch { /* not there, or not ours to remove */ }
}

/**
 * Installed copies make `qmail` work in any terminal (and `quickmail`, the command's earlier name): two small
 * launchers in the per-user folder Windows already keeps on PATH. They run the bundled CLI with the app's own
 * Node runtime, so nothing else needs installing. Rewritten on start so they follow app updates.
 * Earlier versions also wrote a `qm` launcher; it is taken away again, but only if it is ours.
 */
function installCli() {
  if (!app.isPackaged) return
  if (/[\\/]release[\\/]/i.test(process.execPath)) return // a test build must not hijack the installed copy's launchers
  if (process.platform !== 'win32') {
    // macOS and Linux: a shell launcher in ~/.local/bin. An AppImage has no fixed place on disk to point at.
    if (process.env.APPIMAGE) return
    try {
      const bin = path.join(os.homedir(), '.local', 'bin')
      const sh = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${path.join(app.getAppPath(), 'dist', 'cli.mjs')}" "$@"\n`
      fs.mkdirSync(bin, { recursive: true })
      for (const name of ['qmail', 'quickmail']) {
        const file = path.join(bin, name)
        if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== sh) fs.writeFileSync(file, sh, { mode: 0o755 })
      }
      dropOldLauncher(path.join(bin, 'qm'))
    } catch { /* no CLI launcher; the app itself is unaffected */ }
    return
  }
  if (!process.env.LOCALAPPDATA) return
  const dir = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps')
  const cli = path.join(app.getAppPath(), 'dist', 'cli.mjs')
  const body = `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${cli}" %*\r\n`
  for (const name of ['qmail.cmd', 'quickmail.cmd']) {
    try {
      const file = path.join(dir, name)
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== body) fs.writeFileSync(file, body)
    } catch { /* no CLI launcher; the app itself is unaffected */ }
  }
  dropOldLauncher(path.join(dir, 'qm.cmd'))
}

const DEMO = !!process.env.QUICKMAIL_DEMO

/**
 * The mail core runs in helper processes (see host.ts), never here: this process draws the window frame and
 * passes every click along, so anything slow in it (a big query, parsing mail) makes the whole app stutter.
 */
class Host {
  private proc: UtilityProcess | null = null
  private next = 1
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  constructor(private role: 'ui' | 'bg', private onEvent: (event: string, data: any) => void) {}

  private start() {
    const proc = utilityProcess.fork(path.join(__dirname, 'host.js'), [], {
      serviceName: `quickMail ${this.role}`, env: { ...process.env, QUICKMAIL_ROLE: this.role } as Record<string, string>
    })
    proc.on('message', (m: { id?: number; result?: unknown; error?: string; event?: string; data?: unknown }) => {
      if (m.event) return this.onEvent(m.event, m.data)
      const w = this.waiting.get(m.id!)
      if (!w) return
      this.waiting.delete(m.id!)
      if (m.error !== undefined) w.reject(new Error(m.error))
      else w.resolve(m.result)
    })
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null // started again by the next call
      for (const w of this.waiting.values()) w.reject(new Error('The mail service stopped; please try again'))
      this.waiting.clear()
    })
    return (this.proc = proc)
  }

  call<T = any>(method: string, ...args: unknown[]): Promise<T> {
    const proc = this.proc ?? this.start()
    const id = this.next++
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      proc.postMessage({ id, method, args })
    })
  }

  async stop() {
    if (!this.proc) return
    await Promise.race([this.call('closeAll').catch(() => {}), new Promise(r => setTimeout(r, 3000))])
    this.proc?.kill()
  }
}

let quiet: NodeJS.Timeout | undefined
let held: NodeJS.Timeout | undefined
const announce = () => (broadcast('changed'), rebadge())
const onEvent = (role: 'ui' | 'bg') => (event: string, data: any) => {
  if (event === 'sync') return void win?.webContents.send('sync', data)
  if (event === 'open') return external(String(data))
  if (event !== 'changed') return
  if (role === 'ui') {
    // Something the user did: show it right away.
    clearTimeout(quiet)
    quiet = setTimeout(announce, 120)
  } else held ??= setTimeout(() => ((held = undefined), announce()), 2500) // background progress: a few redraws a minute are plenty
}
const ui = new Host('ui', onEvent('ui'))
const bg = new Host('bg', onEvent('bg'))

// Everything the window is allowed to call in the mail core.
const METHODS = new Set([
  'listAccounts', 'listFolders', 'listThreads', 'getThread', 'getMessage', 'setFlags', 'moveMessages', 'deleteMessages',
  'send', 'searchContacts', 'importAccounts', 'importContacts', 'importPasswords', 'setPassword', 'removeAccount',
  'countThreads', 'addMailbox', 'respondInvite', 'listMessages', 'listRules', 'saveRule', 'removeRule', 'applyRules'
])

const broadcast = (channel: string, ...args: unknown[]) => BrowserWindow.getAllWindows().forEach(w => w.webContents.send(channel, ...args))
const owner = (e: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender) ?? win!

let badged = -1

/**
 * Unread inbox count on the taskbar button (and in the window title); the button flashes when new mail lands while
 * you're elsewhere. The badge is put on the taskbar again on every call, changed or not: Windows has been seen
 * holding on to an old number after it was cleared, and this way the next check for mail (a minute at most) puts it right.
 */
const badgeIcons = new Map<string, Electron.NativeImage>()
async function badge() {
  if (!win) return
  const n = await ui.call<number>('unreadInbox')
  if (!win) return
  if (n !== badged) {
    const more = badged >= 0 && n > badged
    badged = n
    win.setTitle(n ? `(${n}) quickMail` : 'quickMail')
    if (more && !win.isFocused()) win.flashFrame(true)
    if (process.platform !== 'win32') app.setBadgeCount(n) // dock badge on macOS, launcher badge on Linux
  }
  if (process.platform !== 'win32') return
  if (!n) return win.setOverlayIcon(null, '')
  const text = n > 99 ? '99+' : String(n)
  let icon = badgeIcons.get(text)
  if (!icon) {
    const url: string = await win.webContents.executeJavaScript(`(() => {
      const c = document.createElement('canvas'); c.width = c.height = 32
      const x = c.getContext('2d')
      x.fillStyle = '#d93025'; x.beginPath(); x.arc(16, 16, 16, 0, 7); x.fill()
      x.fillStyle = '#fff'; x.font = 'bold ${text.length > 2 ? 14 : text.length > 1 ? 19 : 23}px Segoe UI'
      x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('${text}', 16, 17)
      return c.toDataURL()
    })()`)
    badgeIcons.set(text, (icon = nativeImage.createFromDataURL(url)))
  }
  win?.setOverlayIcon(icon, `${n} unread`)
}
// One at a time, in the order asked for, so an older count can never be painted after a newer one.
let badging: Promise<void> = Promise.resolve()
const rebadge = () => (badging = badging.then(badge).catch(() => {}))

// Shown inside quickMail. Everything else goes to the program Windows uses for it, except RISKY types.
const PREVIEW = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'txt', 'log', 'csv', 'md', 'json'])
const RISKY = new Set([
  'exe', 'msi', 'msix', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'dll', 'js', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'psm1',
  'lnk', 'url', 'hta', 'jar', 'reg', 'msc', 'iso', 'img', 'vhd', 'vhdx', 'appx', 'application', 'gadget', 'chm', 'html', 'htm', 'svg', 'xhtml'
])
let previewing = false // true while a viewer window is being created, so it skips the mail-window link rules

/** A picture, PDF or text attachment in a plain viewer window that cannot run scripts from the app or go anywhere. */
function preview(file: string) {
  previewing = true
  const w = new BrowserWindow({
    width: 1000, height: 820, backgroundColor: '#1b1e22', icon: ICON, title: path.basename(file), autoHideMenuBar: true,
    webPreferences: { sandbox: true, plugins: true, partition: 'preview' }
  })
  w.setMenu(null)
  previewing = false
  w.on('page-title-updated', e => e.preventDefault())
  w.webContents.on('will-navigate', e => e.preventDefault())
  w.loadFile(file)
}

/** A conversation in a window of its own. */
function openThread(id: number) {
  const w = new BrowserWindow({
    width: 900, height: 820, minWidth: 480, minHeight: 400, show: false,
    backgroundColor: overlay().color, titleBarStyle: 'hidden', titleBarOverlay: overlay(), icon: ICON,
    webPreferences: { preload: path.join(__dirname, '../preload/index.js') }
  })
  w.setMenu(null)
  w.once('ready-to-show', () => w.show())
  if (process.env.ELECTRON_RENDERER_URL) w.loadURL(`${process.env.ELECTRON_RENDERER_URL}#thread=${id}`)
  else w.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: `thread=${id}` })
}

const overlay = () => ({
  color: nativeTheme.shouldUseDarkColors ? '#111418' : '#f6f8fc',
  symbolColor: nativeTheme.shouldUseDarkColors ? '#e3e3e3' : '#444746',
  height: 56
})

const external = (url: string) => {
  if (/^(https?|mailto):/i.test(url)) shell.openExternal(url)
}

/** Check for new mail everywhere, then quietly download bodies. */
const refresh = (ref?: number | string | null) => (DEMO ? Promise.resolve() : bg.call('refresh', ref ?? null))

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 880, minWidth: 900, minHeight: 560, show: false,
    backgroundColor: overlay().color, titleBarStyle: 'hidden', titleBarOverlay: overlay(), icon: ICON,
    webPreferences: { preload: path.join(__dirname, '../preload/index.js') }
  })
  win.setMenu(null)
  win.once('ready-to-show', () => win?.show())
  win.on('closed', () => {
    win = null
    BrowserWindow.getAllWindows().forEach(w => w.close())
  })
  win.on('focus', () => {
    win?.flashFrame(false)
    win?.webContents.send('changed') // pick up changes made by the CLI
    rebadge()
  })
  win.webContents.on('did-finish-load', () => ((badged = -1), rebadge()))
  win.on('page-title-updated', e => e.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))

  // Verification aid: QUICKMAIL_SHOT=<file.png> saves a screenshot shortly after load and quits.
  const shot = process.env.QUICKMAIL_SHOT
  if (shot)
    win.webContents.once('did-finish-load', () =>
      setTimeout(async () => {
        const js = process.env.QUICKMAIL_SHOT_JS
        if (js) await win!.webContents.executeJavaScript(js).catch(() => {})
        await new Promise(r => setTimeout(r, 1200))
        fs.writeFileSync(shot, (await win!.webContents.capturePage()).toPNG())
        app.quit()
      }, 1500)
    )
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore()
    win?.focus()
  })

  // Mail content must never navigate the app or open windows inside it: links go to the real browser.
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => (external(url), { action: 'deny' }))
    if (previewing) return
    contents.on('will-navigate', (e, url) => {
      if (url !== contents.getURL()) (e.preventDefault(), external(url))
    })
    contents.on('will-frame-navigate', e => {
      if (!e.isMainFrame && !e.url.startsWith('about:')) (e.preventDefault(), external(e.url))
    })
  })

  app.whenReady().then(() => {

    ipcMain.handle('api', (_e, method: string, args: any[]) => {
      if (!METHODS.has(method)) throw new Error(`Unknown method ${method}`)
      return ui.call(method, ...args)
    })
    ipcMain.handle('refresh', (_e, ref?: number) => refresh(ref))

    ipcMain.handle('openThread', (_e, id: number) => openThread(Number(id)))

    ipcMain.handle('pickFiles', async e => {
      const r = await dialog.showOpenDialog(owner(e), { properties: ['openFile', 'multiSelections'] })
      return r.filePaths.map(p => ({ path: p, name: path.basename(p), size: fs.statSync(p).size }))
    })
    ipcMain.handle('fileInfo', (_e, p: string) => ({ path: p, name: path.basename(p), size: fs.statSync(p).size }))
    ipcMain.handle('openAttachment', async (e, id: number, index: number) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quickmail-'))
      const file = await ui.call<string>('saveAttachment', id, index, dir)
      const ext = path.extname(file).slice(1).toLowerCase()
      if (PREVIEW.has(ext)) return preview(file)
      if (RISKY.has(ext)) {
        const r = await dialog.showMessageBox(owner(e), {
          type: 'warning', buttons: ['Show in folder', 'Cancel'], defaultId: 1, cancelId: 1,
          message: `${path.basename(file)} was not opened`,
          detail: 'Files of this type can run programs on your computer, so quickMail will not open them directly. Only open it yourself if you trust the sender.'
        })
        if (r.response === 0) shell.showItemInFolder(file)
        return
      }
      const failed = await shell.openPath(file)
      if (failed) shell.showItemInFolder(file) // nothing installed for this type
    })
    ipcMain.handle('saveAttachment', async (e, id: number, index: number, filename: string) => {
      const r = await dialog.showSaveDialog(owner(e), { defaultPath: path.join(app.getPath('downloads'), filename) })
      return r.filePath ? ui.call('saveAttachment', id, index, r.filePath) : null
    })

    ipcMain.handle('signIn', async (_e, id: number) => {
      const kind = await ui.call<{ google: boolean; url: string; verifier: string }>('signInKind', id)
      if (kind.google) return void (await ui.call('googleSignIn', id))
      const { url, verifier } = kind
      const code = await new Promise<string>((resolve, reject) => {
        const w = new BrowserWindow({ width: 520, height: 720, parent: win!, modal: true, webPreferences: { partition: 'persist:signin' } })
        w.setMenu(null)
        const check = (e: Electron.Event, u: string) => {
          if (!u.startsWith('https://localhost')) return
          e.preventDefault()
          const p = new URL(u).searchParams
          if (p.get('code')) resolve(p.get('code')!)
          else reject(new Error(p.get('error_description')?.split('\n')[0] || 'Sign-in was cancelled'))
          w.destroy()
        }
        w.webContents.on('will-redirect', check)
        w.webContents.on('will-navigate', check)
        w.on('closed', () => reject(new Error('Sign-in window was closed')))
        w.loadURL(url)
      })
      await ui.call('exchangeCode', id, code, verifier)
    })

    nativeTheme.on('updated', () => BrowserWindow.getAllWindows().forEach(w => { try { w.setTitleBarOverlay(overlay()) } catch { /* not on macOS */ } }))

    ipcMain.handle('version', () => app.getVersion())
    ipcMain.handle('updateState', () => updateReady)
    ipcMain.handle('installUpdate', () => updateReady && autoUpdater.quitAndInstall())
    installCli()
    createWindow()
    watchForUpdates()
    refresh().catch(() => {})
    setInterval(() => refresh().catch(() => {}), 60_000)
  })

  app.on('window-all-closed', async () => {
    await Promise.all([ui.stop(), bg.stop()])
    app.quit()
  })
}
