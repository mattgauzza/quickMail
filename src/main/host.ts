// The mail core, run outside the app's main process so the window never waits on it.
// The main process starts two of these: one answers the window (lists, opening mail, actions) and one
// does the background work (checking for new mail, saving message bodies). Each has its own connections
// to the mail servers, so opening a message is never queued behind a background download.
import * as api from '../core/api'

const port = process.parentPort
const emit = (event: string, data?: unknown) => port.postMessage({ event, data })

const METHODS: Record<string, (...a: any[]) => unknown> = {
  // What the window may call (the main process checks the name against its own list first).
  listAccounts: api.listAccounts, listFolders: api.listFolders, listThreads: api.listThreads, getThread: api.getThread,
  getMessage: api.getMessage, setFlags: api.setFlags, moveMessages: api.moveMessages, deleteMessages: api.deleteMessages,
  send: api.send, searchContacts: api.searchContacts, importAccounts: api.importAccounts, importContacts: api.importContacts,
  importPasswords: api.importPasswords, setPassword: api.setPassword, removeAccount: api.removeAccount,
  countThreads: api.countThreads, addMailbox: api.addMailbox, respondInvite: api.respondInvite, listMessages: api.listMessages,
  // What the main process itself needs.
  unreadInbox: api.unreadInbox,
  saveAttachment: api.saveAttachment,
  closeAll: api.closeAll,
  /** Check for new mail everywhere (or in one mailbox), then quietly download bodies. */
  refresh: async (ref?: number | string | null) => {
    if (api.DEMO) return
    await api.sync(ref ?? null, false)
    api.backfill()
  },
  signInKind: (id: number) => {
    const a = api.account(id)
    return api.isGoogle(a) ? { google: true } : { google: false, ...api.authUrl(a.email) }
  },
  googleSignIn: async (id: number) => void (await api.googleSignIn(api.account(id), url => emit('open', url))),
  exchangeCode: (id: number, code: string, verifier: string) => api.exchangeCode(api.account(id), code, verifier)
}

api.events.on('changed', () => emit('changed'))
api.events.on('sync', p => emit('sync', p))

port.on('message', async ({ data }) => {
  const { id, method, args } = data as { id: number; method: string; args: unknown[] }
  try {
    if (!Object.hasOwn(METHODS, method)) throw new Error(`Unknown method ${method}`)
    port.postMessage({ id, result: await METHODS[method](...args) })
  } catch (e: any) {
    port.postMessage({ id, error: String(e?.message ?? e) })
  }
})
