// Draws resources/icon.png (the taskbar / window icon). Run: npx electron scripts/make-icon.cjs
// Keep in step with Logo in src/renderer/src/lib.tsx.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false })
  await w.loadURL('about:blank')
  const url = await w.webContents.executeJavaScript(`(() => {
    const c = document.createElement('canvas'); c.width = c.height = 256
    const x = c.getContext('2d'); x.scale(256 / 48, 256 / 48)
    x.fillStyle = '#0b57d0'; x.beginPath(); x.roundRect(0, 0, 48, 48, 12); x.fill()
    x.lineWidth = 5.5; x.strokeStyle = '#fff'; x.beginPath(); x.arc(23, 23, 10.5, 0, 7); x.stroke()
    x.strokeStyle = '#a8c7fa'; x.lineCap = 'round'; x.beginPath(); x.moveTo(28, 28); x.lineTo(36.5, 36.5); x.stroke()
    return c.toDataURL()
  })()`)
  fs.writeFileSync(path.join(__dirname, '../resources/icon.png'), Buffer.from(url.split(',')[1], 'base64'))
  app.quit()
})
