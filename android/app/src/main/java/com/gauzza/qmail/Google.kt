package com.gauzza.qmail

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
import kotlinx.coroutines.Dispatchers
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

    /** A current access token for an account that already agreed. Works from the background check too. */
    suspend fun token(ctx: Context, email: String): String {
        val r = authorize(ctx, email)
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
 * Returns a function that runs Google sign-in, showing Google's screens when needed.
 * [onDone] gets the result, or an error message to show.
 */
@Composable
fun rememberGoogleSignIn(onDone: (AuthorizationResult?, String?) -> Unit): (email: String?) -> Unit {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { r ->
        if (r.resultCode != Activity.RESULT_OK) onDone(null, "Google sign-in was cancelled.")
        else try { onDone(Google.fromIntent(ctx, r.data), null) } catch (e: Exception) { onDone(null, Google.explain(e)) }
    }
    return { email ->
        scope.launch {
            try {
                val res = Google.authorize(ctx, email)
                val pending = res.pendingIntent
                if (res.hasResolution() && pending != null) launcher.launch(IntentSenderRequest.Builder(pending.intentSender).build())
                else onDone(res, null)
            } catch (e: Exception) {
                onDone(null, Google.explain(e))
            }
        }
    }
}
