import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('qm', {
  call: (method: string, ...args: unknown[]) => ipcRenderer.invoke('api', method, args),
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: 'changed' | 'sync', cb: (...a: any[]) => void) => {
    const h = (_e: unknown, ...a: any[]) => cb(...a)
    ipcRenderer.on(channel, h)
    return () => ipcRenderer.removeListener(channel, h)
  },
  pathFor: (file: File) => webUtils.getPathForFile(file)
})
