// Fills an empty quickMail store with made-up mail, for screenshots and for trying the app without real accounts.
//   npm run demo
// which is: create ./demo-store, seed it, and start the app with QUICKMAIL_HOME=./demo-store QUICKMAIL_DEMO=1
// (demo mode treats the fake mailboxes as signed in and never contacts a mail server).
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

const home = process.env.QUICKMAIL_HOME
if (!home) throw new Error('Set QUICKMAIL_HOME to the demo store folder')
const db = new DatabaseSync(path.join(home, 'mail.db'))
if (db.prepare('SELECT COUNT(*) n FROM accounts').get().n) {
  console.log('demo store already has accounts; leaving it alone')
  process.exit(0)
}

const accounts = [
  ['you@example.com', 'Sam Rivera', '#1a73e8'],
  ['sam@studio.example', 'Sam Rivera', '#188038'],
  ['hello@shop.example', 'Corner Shop', '#9334e6']
]
const folders = [['INBOX', 'Inbox', 'inbox'], ['Sent', 'Sent', 'sent'], ['Drafts', 'Drafts', 'drafts'], ['Archive', 'Archive', 'archive'], ['Junk', 'Junk', 'junk'], ['Trash', 'Trash', 'trash'], ['Receipts', 'Receipts', '']]
accounts.forEach(([email, name, color], i) => {
  db.prepare(`INSERT INTO accounts(id,email,name,username,imap_host,smtp_host,color,status) VALUES(?,?,?,?,?,?,?,'ok')`)
    .run(i + 1, email, name, email, 'imap.example.com', 'smtp.example.com', color)
  folders.forEach(([p, n, r], j) => db.prepare('INSERT INTO folders(id,account_id,path,name,role) VALUES(?,?,?,?,?)').run(i * 10 + j + 1, i + 1, p, n, r))
})

// [account, folder role, from name, from address, subject, body, hours ago, unread, starred, attachments, thread]
const mail = [
  [1, 'inbox', 'Ava Chen', 'ava@northwind.example', 'Re: Website relaunch timeline', 'Monday works. I have attached the revised plan with the new dates; the only open question is whether the pricing page ships in the same release.', 0.3, 1, 0, ['relaunch-plan.pdf'], 't1'],
  [1, 'inbox', 'Marcus Bell', 'marcus@bell.example', 'Re: Website relaunch timeline', 'Monday is fine for me too. I will send the hero copy tonight so design has it first thing.', 5, 0, 0, [], 't1'],
  [1, 'inbox', 'Ava Chen', 'ava@northwind.example', 'Website relaunch timeline', 'Can we get the new hero section in by Monday? Engineering says the rest is on track.', 28, 0, 0, [], 't1'],
  [2, 'inbox', 'Priya Natarajan', 'priya@studio.example', 'Brand photos from Thursday', 'Here are my picks from the shoot. The first two are the strongest for the homepage; the third works better cropped square.', 1.2, 1, 1, ['storefront-01.jpg', 'storefront-02.jpg', 'team-portrait.jpg', 'detail-04.jpg'], null],
  [3, 'inbox', 'Parcel Tracker', 'updates@parcels.example', 'Your order #48213 is out for delivery', 'Good news: your package is on the van and should arrive today between 2 and 6 pm. No signature is needed.', 2.5, 1, 0, [], null],
  [1, 'inbox', 'Jordan Okafor', 'jordan@okafor.example', 'Lunch on Thursday?', 'I am in town Thursday and Friday. Want to grab lunch near your office? That noodle place is still my favourite.', 4, 0, 0, [], null],
  [2, 'inbox', 'Design Weekly', 'newsletter@designweekly.example', 'Issue 212: the return of the sidebar', 'This week: why navigation rails are back, a type scale you can steal, and five small studios doing excellent packaging work.', 7, 0, 0, [], null],
  [3, 'inbox', 'Payments', 'receipts@payments.example', 'Payout of $1,284.50 is on its way', 'Your weekly payout has been sent to the account ending 4410. It usually arrives within two business days.', 9, 0, 0, ['payout-statement.pdf'], null],
  [1, 'inbox', 'City Library', 'notices@library.example', 'Two items are due on Friday', 'The Overstory and A Field Guide to Getting Lost are due back on Friday. You can renew both online if nobody is waiting.', 22, 0, 0, [], null],
  [2, 'inbox', 'Lena Fischer', 'lena@fischer.example', 'Invoice 1187 for October', 'Hi Sam, the October invoice is attached. Thirty days as usual. Thanks for the quick turnaround on the last round of edits.', 26, 0, 1, ['invoice-1187.pdf'], null],
  [1, 'inbox', 'Code Host', 'noreply@codehost.example', '[quickMail] Pull request merged: faster search', 'Your pull request "Faster search suggestions" was merged into main. Two checks passed and the branch was deleted.', 30, 0, 0, [], null],
  [3, 'inbox', 'Noor Haddad', 'noor@haddad.example', 'Do you ship to Canada?', 'Hello! I would love to order two of the ceramic planters. Do you ship to Toronto, and roughly how long does it take?', 33, 0, 0, [], null],
  [1, 'inbox', 'Rail Tickets', 'bookings@rail.example', 'Your trip on 14 December is confirmed', 'Seat 42A, coach C, departing 08:15. Your ticket is attached and also available in the app.', 49, 0, 0, ['ticket-14-dec.pdf'], null],
  [2, 'inbox', 'Tomás Vidal', 'tomas@vidal.example', 'Feedback on the proposal', 'I read it twice. The scope is right and the phasing makes sense; my only worry is the timeline for the second milestone.', 53, 0, 0, [], null],
  [1, 'inbox', 'Health Portal', 'no-reply@health.example', 'Appointment reminder: Tuesday 9:40 am', 'This is a reminder of your appointment on Tuesday at 9:40 am. Please arrive ten minutes early and bring your card.', 74, 0, 0, [], null],
  [3, 'inbox', 'Supplier Desk', 'orders@supplier.example', 'Restock confirmation: 40 units', 'We have confirmed your restock order of 40 units. Dispatch is scheduled for Monday and tracking will follow.', 80, 0, 0, ['order-confirmation.pdf'], null],
  [1, 'inbox', 'Mina Park', 'mina@park.example', 'Photos from the offsite', 'Finally sorted these. The group shot on the ridge came out great. Full album is in the shared folder.', 98, 0, 1, ['ridge-group.jpg', 'campfire.jpg'], null],
  [2, 'inbox', 'Calendar', 'calendar@studio.example', 'Invitation: Design sync, Friday 10:00', 'You have been invited to Design sync on Friday at 10:00. Agenda: homepage review, photo selects, next sprint.', 101, 0, 0, [], null],
  [1, 'inbox', 'Streaming Co', 'billing@streaming.example', 'Your receipt for November', 'Thanks for being a member. Your plan renewed for another month. No action is needed.', 122, 0, 0, [], null],
  [3, 'inbox', 'Elif Demir', 'elif@demir.example', 'The planter arrived broken', 'Sadly one of the two planters arrived cracked. Photos attached. Could you send a replacement or refund that one?', 127, 0, 0, ['damage-1.jpg', 'damage-2.jpg'], null],
  [1, 'inbox', 'Jordan Okafor', 'jordan@okafor.example', 'That book I mentioned', 'It is called The Art of Gathering. Short, practical, and it will change how you run meetings.', 146, 0, 0, [], null],
  [2, 'inbox', 'Accounting', 'books@ledger.example', 'Quarterly summary is ready', 'Your third-quarter summary is ready to review. Revenue is up eleven percent on the previous quarter.', 170, 0, 0, ['q3-summary.pdf'], null],
  [1, 'inbox', 'Ava Chen', 'ava@northwind.example', 'Welcome aboard', 'Delighted to be working together. I have added you to the project space and the weekly call.', 220, 0, 0, [], null],
  [1, 'sent', 'Sam Rivera', 'you@example.com', 'Re: Lunch on Thursday?', 'Thursday is perfect. Noon at the noodle place?', 3, 0, 0, [], null],
  [2, 'sent', 'Sam Rivera', 'sam@studio.example', 'Proposal: homepage refresh', 'Attached is the proposal we discussed, with three phases and a fixed price for the first.', 60, 0, 0, ['proposal.pdf'], null],
  [1, 'junk', 'Prize Centre', 'winner@prizes.example', 'You have been selected!', 'Claim your reward today.', 12, 1, 0, [], null],
  [3, 'Receipts', 'Payments', 'receipts@payments.example', 'Payout of $1,102.75 is on its way', 'Your weekly payout has been sent to the account ending 4410.', 177, 0, 0, [], null]
]

const now = Date.now()
const ins = db.prepare(`INSERT INTO messages(id,account_id,folder_id,uid,message_id,thread_id,subject,from_name,from_addr,to_json,date,seen,flagged,has_attachments,snippet,body_text,body_html,raw)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`)
mail.forEach(([a, where, name, addr, subject, body, hours, unread, star, files, thread], i) => {
  const id = i + 1
  const folder = (a - 1) * 10 + 1 + folders.findIndex(f => f[2] === where || f[1] === where)
  const to = where === 'sent' ? [{ name: 'Jordan Okafor', address: 'jordan@okafor.example' }] : [{ name: accounts[a - 1][1], address: accounts[a - 1][0] }]
  const html = `<p>Hi,</p><p>${body}</p><p>Best,<br>${name.split(' ')[0]}</p>`
  ins.run(id, a, folder, id, `<demo-${id}@example>`, thread ? `<${thread}@example>` : `<demo-${id}@example>`, subject, name, addr, JSON.stringify(to),
    Math.round(now - hours * 3600e3), unread ? 0 : 1, star, files.length ? 1 : 0, body.slice(0, 200), body, html)
  db.prepare('INSERT INTO fts(rowid,subject,sender,recipients,body) VALUES(?,?,?,?,?)').run(id, subject, `${name} ${addr}`, to.map(t => t.address).join(' '), body)
  files.forEach((f, idx) =>
    db.prepare('INSERT INTO attachments(message_id,idx,filename,mime,size) VALUES(?,?,?,?,?)').run(id, idx, f, f.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg', 180000 + idx * 52000))
  const file = path.join(home, 'raw', String(a), `${id}.eml`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `From: ${name} <${addr}>\r\nSubject: ${subject}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}`)
})
const contact = db.prepare('INSERT OR IGNORE INTO contacts(email,name,uses) VALUES(?,?,?)')
for (const m of mail) contact.run(m[3], m[2], 1)
db.close()
console.log(`demo store ready: ${mail.length} messages in ${accounts.length} mailboxes`)
