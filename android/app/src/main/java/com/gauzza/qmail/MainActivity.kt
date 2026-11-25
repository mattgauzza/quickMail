package com.gauzza.qmail

import android.Manifest
import android.app.Application
import android.os.Build
import android.os.Bundle
import android.text.format.DateUtils
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import android.content.Context
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import com.google.android.gms.auth.api.identity.AuthorizationResult
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch


class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { QmailTheme { QmailApp() } }
    }

    override fun onResume() {
        super.onResume()
        Notify.clear(this)
    }
}

const val INBOX = "INBOX"

/** What the list shows: one account's folder, or every account's inbox together when [account] is null. */
data class Place(val account: String? = null, val folder: String = INBOX)

class AppModel(app: Application) : AndroidViewModel(app) {
    private val ctx get() = getApplication<Application>()

    var accounts by mutableStateOf(Accounts.all(app))
        private set
    var view by mutableStateOf(Place())
        private set
    var messages by mutableStateOf(Inbox.cached(app))
        private set
    /** Each account's folders, with unread counts as of the last refresh. Key: account key. */
    var folders by mutableStateOf(accounts.associate { it.key to Boxes.cached(app, it.key) })
        private set
    var loading by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    /** What went wrong per account on the last refresh, e.g. a rejected password. Key: account key. */
    var problems by mutableStateOf<Map<String, String>>(emptyMap())
        private set
    /** Google accounts waiting for the user on Google's sign-in screen. */
    var needsGoogle by mutableStateOf<Set<String>>(emptySet())
        private set
    /** The add-a-mailbox screen, shown over the inbox. */
    var adding by mutableStateOf(false)

    var open by mutableStateOf<Msg?>(null)
    var body by mutableStateOf<String?>(null)
        private set

    init {
        if (accounts.isNotEmpty()) CheckWorker.schedule(app)
    }

    fun accountOf(key: String?) = accounts.firstOrNull { it.key == key }
    fun foldersOf(key: String?) = folders[key].orEmpty()
    private fun boxFor(key: String, role: String) = foldersOf(key).firstOrNull { it.role == role }

    /** The header: "All inboxes" (or "Inbox" with one account), else the folder's name. */
    val title: String
        get() = view.account?.let { k -> foldersOf(k).firstOrNull { it.name == view.folder }?.label }
            ?: when {
                view.account == null -> if (accounts.size > 1) "All inboxes" else "Inbox"
                view.folder == INBOX -> "Inbox"
                else -> view.folder.substringAfterLast('/').substringAfterLast('.')
            }

    private var job: Job? = null
    private var loadingView: Place? = null

    /** One account's folder (newest [n]) plus its folder list, on one connection. */
    private suspend fun loadOne(a: Account, folder: String, n: Int): Pair<List<Msg>, List<Box>?> =
        Mail.connect(a, Accounts.secret(ctx, a)) { st ->
            val boxes = runCatching { Mail.folders(st) }.getOrNull()
            val (validity, list) = Mail.open(st, folder) { f -> f.uidValidity to Mail.recent(f, n) }
            if (folder == INBOX) list.firstOrNull()?.let { SyncState.advance(ctx, a.key, validity, it.uid) }
            list.map { it.copy(account = a.key) } to boxes
        }

    /** Loads what's on screen. "All inboxes" asks every account at once; one slow or failing account doesn't hold up the rest. */
    fun refresh() {
        val list = accounts
        if (list.isEmpty()) return
        val v = view
        if (loading && loadingView == v) return
        job?.cancel()
        loading = true
        loadingView = v
        error = null
        job = viewModelScope.launch {
            try {
                val targets = if (v.account == null) list else listOfNotNull(accountOf(v.account))
                val results = coroutineScope {
                    targets.map { a -> async { a to runCatching { loadOne(a, v.folder, if (v.account == null) 40 else 60) } } }.awaitAll()
                }
                val nextProblems = problems.toMutableMap()
                val nextGoogle = needsGoogle.toMutableSet()
                val nextFolders = folders.toMutableMap()
                val msgs = mutableListOf<Msg>()
                for ((a, r) in results) {
                    r.onSuccess { (m, boxes) ->
                        msgs += m
                        boxes?.let { nextFolders[a.key] = it; Boxes.save(ctx, a.key, it) }
                        nextProblems.remove(a.key); nextGoogle.remove(a.key)
                    }.onFailure { e ->
                        if (e is CancellationException) throw e
                        when {
                            e is Google.NeedsSignIn -> {
                                nextGoogle += a.key; nextProblems[a.key] = "Sign in with Google to load this mailbox."
                            }
                            // Play services can't find this Google account on the phone (often after an import).
                            a.auth == Auth.GOOGLE && e is com.google.android.gms.common.api.ApiException -> {
                                nextGoogle += a.key
                                nextProblems[a.key] = if (Accounts.googleClient(ctx) != null) "Sign in with Google to load this mailbox."
                                    else "This Google account isn't on the phone yet. Sign in to add it."
                            }
                            else -> nextProblems[a.key] = friendly(e)
                        }
                    }
                }
                folders = nextFolders; problems = nextProblems; needsGoogle = nextGoogle
                if (view != v) return@launch
                show(if (v.account == null) msgs.sortedByDescending { it.date } else msgs)
            } finally {
                if (loadingView == v) { loading = false; loadingView = null }
            }
        }
    }

    fun select(target: Place) {
        // With one account, its Inbox and "All inboxes" are the same list.
        val v = if (accounts.size <= 1 && target.folder == INBOX) Place() else target
        if (v == view) return
        view = v
        open = null
        messages = if (v.account == null) Inbox.cached(ctx) else emptyList()
        refresh()
    }

    private fun added() {
        accounts = Accounts.all(ctx)
        folders = accounts.associate { it.key to (folders[it.key] ?: Boxes.cached(ctx, it.key)) }
        adding = false
        CheckWorker.schedule(ctx)
        view = Place()
        messages = Inbox.cached(ctx)
        loadingView = null
        refresh()
    }

    /** Tries the login before saving, so a typo shows here and not as a silent background failure. */
    suspend fun signIn(a: Account, password: String): String? = try {
        Mail.inbox(a, password) { f -> f.messageCount }
        Accounts.save(ctx, a, password)
        SyncState.clear(ctx, a.key)
        added()
        null
    } catch (e: Exception) {
        friendly(e)
    }

    /** Finishes Google sign-in: checks the Gmail permission was granted, finds the address, tests IMAP. */
    suspend fun googleSignedIn(s: Google.Signed): String? = try {
        val token = s.access
        when {
            else -> {
                val email = Google.emailOf(token)
                val old = accountOf(email.lowercase())
                val a = Account(email, "imap.gmail.com", 993, Security.SSL, email, Auth.GOOGLE,
                    smtpHost = old?.smtpHost ?: "smtp.gmail.com")
                Mail.inbox(a, token) { f -> f.messageCount }
                // A browser sign-in keeps its refresh token; a Play services one keeps nothing here.
                Accounts.save(ctx, a, s.refresh)
                GoogleWeb.forget(a.key)
                needsGoogle = needsGoogle - a.key
                problems = problems - a.key
                added()
                null
            }
        }
    } catch (e: Exception) {
        friendly(e)
    }

    /** Adds the mailboxes from the computer's QR code. Returns what to tell the user. */
    fun importFrom(opened: Transfer.Opened): String {
        opened.google?.let { Accounts.saveGoogleClient(ctx, it) }
        opened.microsoft?.let { Microsoft.saveClientId(ctx, it) }
        val incoming = opened.incoming
        // A Microsoft mailbox is only usable with its sign-in (older codes didn't carry one).
        val usable = incoming.filter { it.account.auth != Auth.MICROSOFT || it.password != null }
        usable.forEach { GoogleWeb.forget(it.account.key); Microsoft.forget(it.account.key) }
        val skipped = incoming.size - usable.size
        usable.forEach { Accounts.save(ctx, it.account, it.password) }
        added()
        val google = usable.count { it.account.auth == Auth.GOOGLE && it.password == null }
        return buildString {
            append(if (usable.size == 1) "Added 1 mailbox." else "Added ${usable.size} mailboxes.")
            if (google > 0) append(if (google == 1) " The Google one needs you to sign in." else " The $google Google ones need you to sign in.")
            if (skipped > 0) append(
                if (skipped == 1) " Skipped 1 Microsoft mailbox: its sign-in didn't come with the code. Update Qmail on the computer and send it again."
                else " Skipped $skipped Microsoft mailboxes: their sign-in didn't come with the code. Update Qmail on the computer and send them again.",
            )
        }
    }

    fun showError(message: String?) { error = message }

    /** Removes one mailbox from the phone. Nothing changes on the server. */
    fun remove(key: String) {
        val a = accountOf(key) ?: return
        Accounts.remove(ctx, a)
        accounts = Accounts.all(ctx)
        folders = folders - key
        problems = problems - key
        needsGoogle = needsGoogle - key
        messages = messages.filterNot { it.account == key }
        Inbox.save(ctx, Inbox.cached(ctx).filterNot { it.account == key })
        if (open?.account == key) open = null
        if (accounts.isEmpty()) {
            CheckWorker.cancel(ctx)
            Inbox.clearCache(ctx)
            view = Place()
        } else if (view.account == key) select(Place())
    }

    fun read(m: Msg) {
        open = m
        body = null
        if (!m.seen) markLocal(m, seen = true)
        viewModelScope.launch {
            body = try {
                server(m.account) { st -> Mail.read(st, m.folder, m.uid) }
            } catch (e: Exception) {
                "Couldn't load this message: ${friendly(e)}"
            }
        }
    }

    fun checkNow() = CheckWorker.runNow(ctx)

    // ---------- Changing mail ----------

    /** A short note at the bottom of the screen, with Undo when the change can be reversed. */
    class Snack(val text: String, val undo: (() -> Unit)? = null)
    var snack by mutableStateOf<Snack?>(null)

    /** Where Archive sends this message: its account's Archive folder, or Gmail's All mail. Null when it's already there. */
    fun archiveBox(m: Msg): Box? = (boxFor(m.account, "archive") ?: boxFor(m.account, "all"))?.takeIf { it.name != m.folder }

    /** True where Delete removes for good: in Trash, or on a server without one. */
    fun deletesForGood(m: Msg): Boolean = boxFor(m.account, "trash").let { it == null || it.name == m.folder }

    private suspend fun <T> server(key: String, block: (jakarta.mail.Store) -> T): T {
        val a = accountOf(key) ?: error("That mailbox isn't on this phone any more.")
        return Mail.connect(a, Accounts.secret(ctx, a), block)
    }

    private fun show(list: List<Msg>) {
        messages = list
        if (view.account == null) Inbox.save(ctx, list)
    }

    private fun putBack(m: Msg) {
        if (messages.any { it.id == m.id }) return
        val here = if (view.account == null) m.folder == INBOX else view.account == m.account && view.folder == m.folder
        if (here) show((messages + m).sortedByDescending { if (view.account == null) it.date else it.uid })
    }

    private fun markLocal(m: Msg, seen: Boolean) {
        show(messages.map { if (it.id == m.id) it.copy(seen = seen) else it })
        if (open?.id == m.id) open = open?.copy(seen = seen)
        val d = if (seen) -1 else 1
        folders = folders + (m.account to foldersOf(m.account).map {
            if (it.name == m.folder) it.copy(unread = maxOf(0, it.unread + d)) else it
        })
    }

    fun setSeen(m: Msg, seen: Boolean) {
        markLocal(m, seen)
        if (!seen && open?.id == m.id) open = null // "Mark unread" from the reader goes back to the list
        viewModelScope.launch {
            try { server(m.account) { Mail.setFlag(it, m.folder, m.uid, jakarta.mail.Flags.Flag.SEEN, seen) } }
            catch (e: Exception) { markLocal(m, !seen); error = friendly(e) }
        }
    }

    fun archive(m: Msg) {
        val to = archiveBox(m) ?: return run { error = "This mailbox has no Archive folder." }
        moveTo(m, to, "Archived")
    }

    /** Moves to Trash. In Trash itself the UI asks first and calls [destroy]. */
    fun delete(m: Msg) {
        val trash = boxFor(m.account, "trash")
        if (trash == null || trash.name == m.folder) destroy(m) else moveTo(m, trash, "Moved to Trash")
    }

    fun moveTo(m: Msg, to: Box, done: String = "Moved to ${to.label}") {
        show(messages.filterNot { it.id == m.id })
        if (open?.id == m.id) open = null
        viewModelScope.launch {
            try {
                val newUid = server(m.account) { Mail.move(it, m.folder, m.uid, to.name) }
                snack = Snack(done, newUid?.let { uid -> { undoMove(m, to.name, uid) } })
            } catch (e: Exception) {
                putBack(m)
                error = friendly(e)
            }
        }
    }

    private fun undoMove(m: Msg, to: String, uid: Long) {
        viewModelScope.launch {
            try {
                server(m.account) { Mail.move(it, to, uid, m.folder) }
                loadingView = null
                refresh() // the message has a new UID back where it came from
            } catch (e: Exception) {
                error = "Couldn't undo: ${friendly(e)}"
            }
        }
    }

    /** A message waiting for the user to confirm "Delete forever". */
    var doomed by mutableStateOf<Msg?>(null)

    /** Delete as the user means it: to Trash, or (in Trash) ask first. */
    fun askDelete(m: Msg) { if (deletesForGood(m)) doomed = m else delete(m) }

    fun destroy(m: Msg) {
        show(messages.filterNot { it.id == m.id })
        if (open?.id == m.id) open = null
        viewModelScope.launch {
            try {
                server(m.account) { Mail.destroy(it, m.folder, m.uid) }
                snack = Snack("Deleted forever")
            } catch (e: Exception) {
                putBack(m)
                error = friendly(e)
            }
        }
    }
}

private fun friendly(e: Throwable): String {
    val chain = generateSequence(e) { it.cause }.toList()
    val text = chain.joinToString(" ") { (it.message ?: "") + " " + it.javaClass.simpleName }.lowercase()
    return when {
        e is Google.NeedsSignIn -> "Google needs you to sign in again."
        "authenticationfailed" in text || "invalid credentials" in text || "authenticate failed" in text ||
            "login failed" in text -> "The server rejected the login. Check the password (Gmail and iCloud need an app password)."
        "unknownhost" in text -> "Can't find that server. Check the IMAP host."
        "timeout" in text || "timed out" in text -> "The server didn't answer in time."
        "connectexception" in text || "connection refused" in text -> "Couldn't connect. Check the host, port and security."
        "certificate" in text || "sslhandshake" in text -> "The server's security certificate didn't check out."
        else -> chain.last().message ?: e.javaClass.simpleName
    }
}

