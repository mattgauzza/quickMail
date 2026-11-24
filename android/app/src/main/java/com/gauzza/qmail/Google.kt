package com.gauzza.qmail

import android.accounts.AccountManager
import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Scope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Gmail access through Google Play services' Authorization API. There is no client secret and no
 * server: Google recognises the app by its package name and signing certificate (the Android OAuth
 * client in the quickmail-gauzza Cloud project) and hands out short-lived access tokens, silently
 * once the user has agreed.
 */
object Google {
    const val MAIL = "https://mail.google.com/"

    /** The user has to see a Google screen (first consent, or access was revoked). */
    class NeedsSignIn(val intent: PendingIntent?) : Exception("Google needs you to sign in again.")

    private fun request(email: String?) = AuthorizationRequest.builder()
        .setRequestedScopes(listOf(Scope(MAIL), Scope("email")))
        .apply { if (email != null) setAccount(android.accounts.Account(email, "com.google")) }
        .build()

    suspend fun authorize(ctx: Context, email: String?): AuthorizationResult =
        Identity.getAuthorizationClient(ctx).authorize(request(email)).await()

    fun fromIntent(ctx: Context, data: Intent?): AuthorizationResult =
        Identity.getAuthorizationClient(ctx).getAuthorizationResultFromIntent(data)

    /** What a finished sign-in hands over: an access token, and a refresh token when it came from the browser. */
    class Signed(val access: String, val refresh: String?)

    /**
     * A current access token for a mailbox that already agreed. Works from the background check too.
     * Mailboxes from the computer (or signed in through the browser) use their refresh token; others, Play services.
     */
    suspend fun token(ctx: Context, a: Account): String {
        Accounts.password(ctx, a)?.let { return GoogleWeb.access(ctx, a, it) }
        val r = authorize(ctx, a.email)
        if (r.hasResolution()) throw NeedsSignIn(r.pendingIntent)
        return r.accessToken ?: throw NeedsSignIn(null)
    }

    /** Which address the token belongs to (the account picker decides, not the user's typing). */
    suspend fun emailOf(token: String): String = withContext(Dispatchers.IO) {
        val c = URL("https://openidconnect.googleapis.com/v1/userinfo").openConnection() as HttpURLConnection
        c.setRequestProperty("Authorization", "Bearer $token")
        c.connectTimeout = 15000; c.readTimeout = 15000
        try {
            if (c.responseCode != 200) error("Google didn't say which account this is (HTTP ${c.responseCode}).")
            JSONObject(c.inputStream.bufferedReader().readText()).getString("email")
        } finally {
            c.disconnect()
        }
    }

    fun explain(e: Throwable): String = when {
        e is ApiException && e.statusCode == CommonStatusCodes.DEVELOPER_ERROR ->
            "Google doesn't recognise this build of Qmail yet. Its Android OAuth client (package name and " +
                "signing SHA-1) needs adding to the Google Cloud project."
        e is ApiException && e.statusCode == CommonStatusCodes.NETWORK_ERROR -> "No connection to Google."
        e is ApiException && e.statusCode == CommonStatusCodes.CANCELED -> "Google sign-in was cancelled."
        else -> e.message ?: e.javaClass.simpleName
    }
}

/**
 * Returns a function that runs Google sign-in. With Qmail's Google client (it comes with an import from the
 * computer) that is the browser, and the Google account never has to be added to the phone. Without it,
 * Play services: with an [email] it signs in to that address; without one (adding a mailbox), or when that
 * address isn't on the phone yet, Android's account picker comes first. (Asking Play services for no
 * particular account silently returns one that already agreed, so that is never done.)
 * [onDone] gets the result, or an error message to show.
 */
@Composable
fun rememberGoogleSignIn(onDone: (Google.Signed?, String?) -> Unit): (email: String?) -> Unit {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var browser by remember { mutableStateOf<Job?>(null) }
    fun granted(r: AuthorizationResult) {
        val token = r.accessToken
        when {
            token == null -> onDone(null, "Google didn't grant access. Try again.")
            Google.MAIL !in r.grantedScopes ->
                onDone(null, "Qmail needs permission to read, send and organise your Gmail. Sign in again and tick that box.")
            else -> onDone(Google.Signed(token, null), null)
        }
    }
    val consent = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { r ->
        if (r.resultCode != Activity.RESULT_OK) onDone(null, "Google sign-in was cancelled.")
        else try { granted(Google.fromIntent(ctx, r.data)) } catch (e: Exception) { onDone(null, Google.explain(e)) }
    }
    fun play(email: String, onMissing: () -> Unit) = scope.launch {
        try {
            val res = Google.authorize(ctx, email)
            val pending = res.pendingIntent
            if (res.hasResolution() && pending != null) consent.launch(IntentSenderRequest.Builder(pending.intentSender).build())
            else granted(res)
        } catch (e: ApiException) {
            onMissing()
        } catch (e: Exception) {
            onDone(null, Google.explain(e))
        }
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val name = r.data?.getStringExtra(AccountManager.KEY_ACCOUNT_NAME)
        if (r.resultCode != Activity.RESULT_OK || name == null) onDone(null, "Google sign-in was cancelled.")
        else play(name) { onDone(null, "Google couldn't sign in to $name on this phone.") }
    }
    fun pick(email: String?) = picker.launch(
        AccountManager.newChooseAccountIntent(
            email?.let { android.accounts.Account(it, "com.google") }, null, arrayOf("com.google"),
            email?.let { "Choose $it, or add it to this phone" }, null, null, null,
        )
    )
    return { email ->
        val client = Accounts.googleClient(ctx)
        if (client != null) {
            // A second tap starts over (say the browser tab was closed).
            browser?.cancel()
            browser = scope.launch {
                try {
                    val t = GoogleWeb.signIn(ctx, client, email)
                    onDone(Google.Signed(t.access, t.refresh), null)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    onDone(null, e.message ?: "Google sign-in failed.")
                }
            }
        } else if (email == null) pick(null)
        else play(email) { pick(email) } // That address isn't on the phone yet.
    }
}
