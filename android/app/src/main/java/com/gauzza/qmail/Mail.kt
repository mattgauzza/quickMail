package com.gauzza.qmail

import android.content.Context
import android.text.Html
import jakarta.mail.FetchProfile
import jakarta.mail.Flags
import jakarta.mail.Folder
import jakarta.mail.Message
import jakarta.mail.Multipart
import jakarta.mail.Part
import jakarta.mail.Session
import jakarta.mail.Store
import jakarta.mail.UIDFolder
import jakarta.mail.internet.InternetAddress
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.eclipse.angus.mail.imap.IMAPFolder
import org.eclipse.angus.mail.imap.IMAPStore
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Properties

data class Msg(
    val uid: Long,
    val fromName: String,
    val fromAddr: String,
    val subject: String,
    val date: Long,
    val seen: Boolean,
    /** The account's key (its address, lower-cased) and the folder's full name on the server. */
    val account: String = "",
    val folder: String = "",
) {
    /** Unique across accounts and folders, for list keys. */
    val id: String get() = "$account|$folder|$uid"
}

object Mail {
    private fun session(a: Account): Pair<Session, String> {
        val proto = if (a.security == Security.SSL) "imaps" else "imap"
        val p = Properties()
        p["mail.store.protocol"] = proto
        p["mail.$proto.host"] = a.host
        p["mail.$proto.port"] = a.port.toString()
        p["mail.$proto.connectiontimeout"] = "15000"
        p["mail.$proto.timeout"] = "30000"
        p["mail.$proto.writetimeout"] = "30000"
        if (a.security == Security.SSL) p["mail.imaps.ssl.checkserveridentity"] = "true"
        // Google accounts log in with SASL XOAUTH2, the access token taking the password's place.
        if (a.auth == Auth.GOOGLE) p["mail.$proto.auth.mechanisms"] = "XOAUTH2"
        if (a.security == Security.STARTTLS) {
            p["mail.imap.starttls.enable"] = "true"
            p["mail.imap.starttls.required"] = "true"
            p["mail.imap.ssl.checkserveridentity"] = "true"
        }
        return Session.getInstance(p) to proto
    }

    /** Logs in for one job, then logs out. */
    suspend fun <T> connect(a: Account, secret: String, block: (Store) -> T): T =
        withContext(Dispatchers.IO) {
            val (s, proto) = session(a)
            val store = s.getStore(proto)
            store.connect(a.host, a.port, a.user, secret)
            try { block(store) } finally { runCatching { store.close() } }
        }

    /** Opens one folder read-only on a connected store. */
    fun <T> open(store: Store, name: String, block: (IMAPFolder) -> T): T {
        val f = store.getFolder(name) as IMAPFolder
        f.open(Folder.READ_ONLY)
        return try { block(f) } finally { runCatching { f.close(false) } }
    }

    /** Opens one folder for changes. Closing doesn't expunge, so nothing is removed by accident. */
    fun <T> openRW(store: Store, name: String, block: (IMAPFolder) -> T): T {
        val f = store.getFolder(name) as IMAPFolder
        f.open(Folder.READ_WRITE)
        return try { block(f) } finally { runCatching { f.close(false) } }
    }

    private fun one(f: IMAPFolder, uid: Long) =
        f.getMessageByUID(uid) ?: throw IllegalStateException("That email is no longer in ${f.name}.")

    fun setFlag(store: Store, folder: String, uid: Long, flag: Flags.Flag, on: Boolean) =
        openRW(store, folder) { f -> one(f, uid).setFlag(flag, on) }

    /** The text of a message, marking it read as any mail app does when you open it. */
    fun read(store: Store, folder: String, uid: Long): String = try {
        openRW(store, folder) { f -> body(f, uid).also { f.getMessageByUID(uid)?.setFlag(Flags.Flag.SEEN, true) } }
    } catch (e: jakarta.mail.MessagingException) {
        open(store, folder) { f -> body(f, uid) } // some folders can't be opened for changes
    }

    /**
     * Moves one message and returns its UID in [to] when the server reports it (UIDPLUS), so the move can be undone.
     * Uses MOVE where the server has it, otherwise copy + delete + expunge of just that message.
     */
    fun move(store: Store, from: String, uid: Long, to: String): Long? = openRW(store, from) { f ->
        val m = arrayOf(one(f, uid))
        val dest = store.getFolder(to)
        if ((store as IMAPStore).hasCapability("MOVE")) {
            runCatching { f.moveUIDMessages(m, dest)?.firstOrNull()?.uid }.getOrElse { f.moveMessages(m, dest); null }
        } else {
            val newUid = runCatching { f.copyUIDMessages(m, dest)?.firstOrNull()?.uid }.getOrElse { f.copyMessages(m, dest); null }
            m[0].setFlag(Flags.Flag.DELETED, true)
            f.expunge(m)
            newUid
        }
    }

    /** Deletes for good. Only used from Trash (or where there is no Trash), after the user confirms. */
    fun destroy(store: Store, folder: String, uid: Long) = openRW(store, folder) { f ->
        val m = arrayOf(one(f, uid))
        m[0].setFlag(Flags.Flag.DELETED, true)
        f.expunge(m)
    }

    suspend fun <T> folder(a: Account, secret: String, name: String, block: (IMAPFolder) -> T): T =
        connect(a, secret) { open(it, name, block) }

    /** Opens INBOX read-only for one job, then logs out. */
    suspend fun <T> inbox(a: Account, secret: String, block: (IMAPFolder) -> T): T = folder(a, secret, "INBOX", block)

    private val ROLE_ATTRS = mapOf(
        "\\sent" to "sent", "\\drafts" to "drafts", "\\trash" to "trash", "\\junk" to "junk",
        "\\archive" to "archive", "\\all" to "all", "\\flagged" to "starred",
    )
    private val ROLE_NAMES = mapOf(
        "sent" to "sent", "sent items" to "sent", "sent mail" to "sent", "sent messages" to "sent",
        "drafts" to "drafts", "trash" to "trash", "deleted items" to "trash", "deleted messages" to "trash", "bin" to "trash",
        "junk" to "junk", "spam" to "junk", "junk e-mail" to "junk", "junk email" to "junk",
        "archive" to "archive", "all mail" to "all", "starred" to "starred",
    )
    private val ORDER = listOf("inbox", "starred", "sent", "drafts", "archive", "all", "junk", "trash")
    private val LABELS = mapOf(
        "inbox" to "Inbox", "starred" to "Starred", "sent" to "Sent", "drafts" to "Drafts", "archive" to "Archive",
        "all" to "All mail", "junk" to "Spam", "trash" to "Trash",
    )

    /**
     * Every folder that can hold mail, special ones first (Inbox, Starred, Sent, ...) in the desktop app's order,
     * then the rest by name so subfolders follow their parent. Unread counts come from one STATUS per folder.
     */
    fun folders(store: Store): List<Box> {
        val seen = mutableSetOf<String>()
        return store.defaultFolder.list("*").map { it as IMAPFolder }.mapNotNull { f ->
            val attrs = f.attributes.map { it.lowercase() }.toSet()
            if ("\\noselect" in attrs || "\\nonexistent" in attrs) return@mapNotNull null
            val parts = f.fullName.split(f.separator)
            val inbox = f.fullName.equals("INBOX", ignoreCase = true)
            var role = if (inbox) "inbox" else attrs.firstNotNullOfOrNull { ROLE_ATTRS[it] } ?: ROLE_NAMES[parts.last().lowercase()]
            if (role != null && !seen.add(role)) role = null // only one Sent, one Trash...
            val system = parts.first().let { it == "[Gmail]" || it == "[Google Mail]" }
            Box(
                name = f.fullName,
                label = LABELS[role] ?: parts.last(),
                role = role,
                unread = if (role in setOf("sent", "drafts", "trash", "all")) 0 else runCatching { f.unreadMessageCount }.getOrDefault(0),
                depth = if (role != null || system) 0 else parts.size - 1,
            )
        }.sortedWith(compareBy<Box>({ ORDER.indexOf(it.role).let { i -> if (i < 0) 99 else i } }, { it.name.lowercase() }))
    }

    private fun toMsg(f: IMAPFolder, m: Message): Msg {
        val from = m.from?.firstOrNull() as? InternetAddress
        return Msg(
            uid = f.getUID(m),
            fromName = from?.personal ?: "",
            fromAddr = from?.address ?: "",
            subject = m.subject ?: "",
            date = (m.receivedDate ?: m.sentDate)?.time ?: 0,
            seen = m.isSet(Flags.Flag.SEEN),
        )
    }

    private fun fetch(f: IMAPFolder, msgs: Array<Message>): List<Msg> {
        if (msgs.isEmpty()) return emptyList()
        val fp = FetchProfile().apply {
            add(FetchProfile.Item.ENVELOPE)
            add(FetchProfile.Item.FLAGS)
            add(UIDFolder.FetchProfileItem.UID)
        }
        f.fetch(msgs, fp)
        return msgs.map { toMsg(f, it).copy(folder = f.fullName) }.sortedByDescending { it.uid }
    }

    /** The newest [n] messages. */
    fun recent(f: IMAPFolder, n: Int = 60): List<Msg> {
        val count = f.messageCount
        if (count == 0) return emptyList()
        return fetch(f, f.getMessages(maxOf(1, count - n + 1), count))
    }

    /** Messages with a UID above [uid]. IMAP returns the last message for an empty range, so filter it. */
    fun newer(f: IMAPFolder, uid: Long): List<Msg> =
        fetch(f, f.getMessagesByUID(uid + 1, UIDFolder.MAXUID)).filter { it.uid > uid }

    /** Readable text of one message: plain text if it has it, else the HTML flattened. */
    fun body(f: IMAPFolder, uid: Long): String {
        val m = f.getMessageByUID(uid) ?: return "(This message is no longer in the inbox.)"
        return text(m)?.trim().orEmpty().ifEmpty { "(No text in this message.)" }
    }

    private fun text(p: Part): String? {
        if (p.isMimeType("text/plain")) return p.content as? String
        if (p.isMimeType("text/html")) {
            val html = p.content as? String ?: return null
            return Html.fromHtml(html, Html.FROM_HTML_MODE_COMPACT).toString()
        }
        if (p.isMimeType("multipart/alternative")) {
            val mp = p.content as Multipart
            val parts = (0 until mp.count).map { mp.getBodyPart(it) }
            parts.firstOrNull { it.isMimeType("text/plain") }?.let { return text(it) }
            parts.forEach { part -> text(part)?.let { return it } }
            return null
        }
        if (p.isMimeType("multipart/*")) {
            val mp = p.content as Multipart
            for (i in 0 until mp.count) {
                val part = mp.getBodyPart(i)
                if (Part.ATTACHMENT.equals(part.disposition, ignoreCase = true)) continue
                text(part)?.let { return it }
            }
        }
        if (p.isMimeType("message/rfc822")) return text(p.content as Part)
        return null
    }
}

/** One mail folder. [name] is the server's full name, [role] is inbox/sent/trash/... or null for the user's own. */
data class Box(val name: String, val label: String, val role: String?, val unread: Int, val depth: Int)

/** The last folder list, so the drawer fills at once. */
object Boxes {
    private fun file(ctx: Context, key: String) = File(ctx.filesDir, "folders-${key.hashCode().toUInt()}.json")

    fun cached(ctx: Context, key: String): List<Box> = runCatching {
        val arr = JSONArray(file(ctx, key).readText())
        (0 until arr.length()).map {
            val o = arr.getJSONObject(it)
            Box(o.getString("name"), o.getString("label"), o.optString("role").ifEmpty { null }, o.getInt("unread"), o.getInt("depth"))
        }
    }.getOrDefault(emptyList())

    fun save(ctx: Context, key: String, list: List<Box>) {
        val arr = JSONArray()
        list.forEach {
            arr.put(JSONObject().put("name", it.name).put("label", it.label).put("role", it.role ?: "")
                .put("unread", it.unread).put("depth", it.depth))
        }
        file(ctx, key).writeText(arr.toString())
    }

    fun clear(ctx: Context, key: String) { file(ctx, key).delete() }
}

/** The last inbox list, kept on disk so the app opens on mail instead of a spinner. */
object Inbox {
    private fun file(ctx: Context) = File(ctx.filesDir, "inbox.json")

    fun cached(ctx: Context): List<Msg> = runCatching {
        val arr = JSONArray(file(ctx).readText())
        (0 until arr.length()).map {
            val o = arr.getJSONObject(it)
            Msg(o.getLong("uid"), o.getString("fromName"), o.getString("fromAddr"),
                o.getString("subject"), o.getLong("date"), o.getBoolean("seen"),
                o.optString("account"), o.optString("folder", "INBOX"))
        }.filter { it.account.isNotEmpty() } // lists saved by 0.1 don't say which account
    }.getOrDefault(emptyList())

    fun save(ctx: Context, list: List<Msg>) {
        val arr = JSONArray()
        list.forEach {
            arr.put(JSONObject().put("uid", it.uid).put("fromName", it.fromName).put("fromAddr", it.fromAddr)
                .put("subject", it.subject).put("date", it.date).put("seen", it.seen)
                .put("account", it.account).put("folder", it.folder))
        }
        file(ctx).writeText(arr.toString())
    }

    fun clearCache(ctx: Context) { file(ctx).delete() }
}
