import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Popout } from './Popout'
import './styles.css'

const thread = location.hash.match(/^#thread=(\d+)$/)
createRoot(document.getElementById('root')!).render(thread ? <Popout id={Number(thread[1])} /> : <App />)
