package com.gauzza.qmail

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap

/**
 * Microsoft 365 / Outlook mailboxes, which arrive from the computer with their refresh token and the public
 * client ID it was issued to (no secret). The phone has no Microsoft sign-in screen of its own: the computer
 * signs in by pasting a link, which doesn't suit a phone. When Microsoft ends the sign-in, the mailbox has
 * to be sent from the computer again.
 */
object Microsoft {
    private const val TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
    private const val SCOPE = "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access"
    /** The desktop app's default (Thunderbird's public registration), used when a code didn't say. */
    private const val DEFAULT_CLIENT = "9e5f94bc-e8a4-4e73-b8be-63364c29d753"

    class SendAgain(email: String) :
        Exception("Microsoft ended the sign-in for $email. On the computer, open Settings → Phone and send it again.")

    private val cache = ConcurrentHashMap<String, Pair<String, Long>>()

    fun clientId(ctx: Context): String = Accounts.prefs(ctx).getString("ms-client", null) ?: DEFAULT_CLIENT

    fun saveClientId(ctx: Context, id: String) {
        Accounts.prefs(ctx).edit().putString("ms-client", id).apply()
    }

    fun forget(key: String) {
        cache.remove(key)
    }

    /** A current access token. Microsoft hands back a new refresh token each time; it replaces the saved one. */
    suspend fun access(ctx: Context, a: Account): String {
        cache[a.key]?.let { (token, until) -> if (until > System.currentTimeMillis()) return token }
        val refresh = Accounts.password(ctx, a) ?: throw SendAgain(a.email)
        val json = post(
            mapOf("grant_type" to "refresh_token", "refresh_token" to refresh, "client_id" to clientId(ctx), "scope" to SCOPE),
            a.email,
        )
        json.optString("refresh_token").ifEmpty { null }?.let { if (it != refresh) Accounts.save(ctx, a, it) }
        val token = json.getString("access_token")
        cache[a.key] = token to System.currentTimeMillis() + (json.optLong("expires_in", 3600) - 120) * 1000
        return token
    }

    private suspend fun post(params: Map<String, String>, email: String): JSONObject = withContext(Dispatchers.IO) {
        val c = URL(TOKEN).openConnection() as HttpURLConnection
        c.requestMethod = "POST"
        c.doOutput = true
        c.connectTimeout = 15000
        c.readTimeout = 15000
        c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
        try {
            val body = params.entries.joinToString("&") { (k, v) -> "$k=" + URLEncoder.encode(v, "UTF-8") }
            c.outputStream.use { it.write(body.toByteArray()) }
            val ok = c.responseCode in 200..299
            val json = JSONObject((if (ok) c.inputStream else c.errorStream)?.bufferedReader()?.readText() ?: "{}")
            if (!ok) {
                // invalid_grant: revoked, expired or the password changed. interaction_required: MFA or consent again.
                if (json.optString("error") in setOf("invalid_grant", "interaction_required")) throw SendAgain(email)
                throw Exception("Microsoft: " + json.optString("error_description", json.optString("error", "HTTP ${c.responseCode}"))
                    .lineSequence().first())
            }
            json
        } finally {
            c.disconnect()
        }
    }
}
