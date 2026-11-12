import { useEffect, useRef, useState } from 'react'
import { Compose, type ComposeState } from './Compose'
import { ThreadView } from './ThreadView'
import { type Account, type Message, call } from './lib'

/** One conversation in a window of its own. */
export function Popout({ id }: { id: number }) {
  const [thread, setThread] = useState<{ id: number; role: string; folder: string; ids: number[] } | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [compose, setCompose] = useState<{ key: number; state: ComposeState } | null>(null)
  const [toast, setToast] = useState('')
  const latest = useRef<Message | null>(null)

  useEffect(() => {
    Promise.all([call('getThread', id, true), call('listAccounts')]).then(
      ([ms, a]) => {
        const m = ms.find(x => x.id === id) ?? ms[ms.length - 1]
        document.title = m.subject || 'quickMail'
        setThread({ id, role: m.role, folder: m.folder, ids: ms.filter(x => x.role === m.role).map(x => x.id) })
        setAccounts(a)
      },
      () => window.close()
    )
  }, [id])

  if (!thread) return null
  const act = async (kind: 'archive' | 'trash' | 'junk' | 'inbox' | 'unread') => {
    try {
      if (kind === 'unread') await call('setFlags', thread.ids, { seen: false })
      else if (kind === 'trash') await call('deleteMessages', thread.ids)
      else await call('moveMessages', thread.ids, kind)
      window.close()
    } catch (e: any) {
      setToast(String(e?.message ?? e))
    }
  }

  return (
    <div className="popout">
      <ThreadView thread={thread} latest={latest} mode="window" onBack={() => window.close()} onAct={act} onCompose={state => setCompose({ key: Date.now(), state })} />
      {compose && (
        <Compose
          key={compose.key} initial={compose.state} accounts={accounts}
          onClose={() => setCompose(null)} onSent={msg => (setCompose(null), setToast(msg), setTimeout(() => setToast(''), 4000))}
        />
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}
