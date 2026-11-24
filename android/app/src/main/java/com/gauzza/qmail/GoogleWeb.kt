package com.gauzza.qmail

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.job
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.URL
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap

/**
 * Gmail without the Google account on the phone, using the same "Desktop app" OAuth client the computer
 * uses (it arrives with the QR import). Sign-in happens in the browser, with a one-off listener on 127.0.0.1
 * for Google's redirect, as on the computer. After that a refresh token, kept encrypted, gets access tokens.
 */
object GoogleWeb {
    private const val AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
    private const val TOKEN = "https://oauth2.googleapis.com/token"
    private const val SCOPE = "openid email https://mail.google.com/"
    private const val B64 = Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP

    class Tokens(val access: String, val refresh: String?, val expiresIn: Long)

    private val cache = ConcurrentHashMap<String, Pair<String, Long>>()

    /** A current access token from the saved refresh token. A revoked or expired sign-in asks for a new one. */
    suspend fun access(ctx: Context, a: Account, refresh: String): String {
        cache[a.key]?.let { (token, until) -> if (until > System.currentTimeMillis()) return token }
        val c = Accounts.googleClient(ctx) ?: throw Google.NeedsSignIn(null)
        val t = post(mapOf("grant_type" to "refresh_token", "refresh_token" to refresh, "client_id" to c.id, "client_secret" to c.secret))
        remember(a.key, t)
        return t.access
    }

    fun remember(key: String, t: Tokens) {
        cache[key] = t.access to System.currentTimeMillis() + (t.expiresIn - 120) * 1000
    }

    fun forget(key: String) {
        cache.remove(key)
    }

    /**
     * Opens Google's sign-in page in the browser ([hint] preselects that address) and waits for its
     * redirect. Cancelling the coroutine stops the listener.
     */
    suspend fun signIn(ctx: Context, c: Accounts.GoogleClient, hint: String?): Tokens {
        val random = SecureRandom()
        val verifier = Base64.encodeToString(ByteArray(32).also(random::nextBytes), B64)
        val state = Base64.encodeToString(ByteArray(16).also(random::nextBytes), B64)
        val challenge = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()), B64)
        val server = ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"))
        currentCoroutineContext().job.invokeOnCompletion { runCatching { server.close() } }
        val redirect = "http://127.0.0.1:${server.localPort}"
        val params = mutableMapOf(
            "client_id" to c.id, "response_type" to "code", "redirect_uri" to redirect, "scope" to SCOPE, "state" to state,
            "access_type" to "offline", "prompt" to "consent", "code_challenge_method" to "S256", "code_challenge" to challenge,
        )
        if (hint != null) params["login_hint"] = hint
        ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("$AUTH?" + form(params))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val back = "intent://signed-in#Intent;scheme=qmail;package=${ctx.packageName};end"
        val code = withContext(Dispatchers.IO) {
            server.soTimeout = 10 * 60_000
            try {
                server.use { waitForCode(it, state, back) }
            } catch (e: SocketTimeoutException) {
                throw Exception("Google sign-in timed out. Try again.")
            } catch (e: SocketException) {
                throw Exception("Google sign-in was cancelled.")
            }
        }
        val t = post(
            mapOf(
                "grant_type" to "authorization_code", "code" to code, "redirect_uri" to redirect, "code_verifier" to verifier,
                "client_id" to c.id, "client_secret" to c.secret,
            ),
        )
        if (t.refresh == null) throw Exception("Google didn't return a lasting sign-in. Try again.")
        return t
    }

    /** Answers the browser's requests until one carries Google's answer, and returns the code. */
    private fun waitForCode(server: ServerSocket, state: String, back: String): String {
        while (true) {
            server.accept().use { s ->
                val line = s.getInputStream().bufferedReader().readLine() ?: return@use
                val query = line.split(" ").getOrNull(1)?.substringAfter('?', "") ?: ""
                val q = query.split('&').filter { '=' in it }.associate {
                    URLDecoder.decode(it.substringBefore('='), "UTF-8") to URLDecoder.decode(it.substringAfter('='), "UTF-8")
                }
                val out = s.getOutputStream()
                if (q["code"] == null && q["error"] == null) {
                    out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                    return@use
                }
                val good = q["code"] != null && q["state"] == state
                val message = if (good) "You're signed in." else "Sign-in didn't finish. Go back to Qmail and try again."
                // Back to the app: a tap on the button always works; the automatic jump may be blocked by the browser.
                val body = "<!doctype html><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
                    "<body style=\"font:17px system-ui;margin:18vh 24px;text-align:center\"><h2>Qmail</h2><p>$message</p>" +
                    "<p><a href=\"$back\" style=\"display:inline-block;padding:14px 28px;border-radius:24px;" +
                    "background:#0B57D0;color:#fff;text-decoration:none\">Back to Qmail</a></p>" +
                    "<script>setTimeout(function(){location.href=${JSONObject.quote(back)}},300)</script></body>"
                val bytes = body.toByteArray()
                out.write(
                    ("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${bytes.size}\r\n" +
                        "Connection: close\r\n\r\n").toByteArray() + bytes,
                )
                out.flush()
                if (good) return q["code"]!!
                throw Exception(if (q["error"] == "access_denied") "Google sign-in was cancelled." else "Google sign-in failed. Try again.")
            }
        }
    }

    private fun form(p: Map<String, String>) = p.entries.joinToString("&") { (k, v) -> "$k=" + URLEncoder.encode(v, "UTF-8") }

    private suspend fun post(params: Map<String, String>): Tokens = withContext(Dispatchers.IO) {
        val c = URL(TOKEN).openConnection() as HttpURLConnection
        c.requestMethod = "POST"
        c.doOutput = true
        c.connectTimeout = 15000
        c.readTimeout = 15000
        c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
        try {
            c.outputStream.use { it.write(form(params).toByteArray()) }
            val ok = c.responseCode in 200..299
            val json = JSONObject((if (ok) c.inputStream else c.errorStream)?.bufferedReader()?.readText() ?: "{}")
            if (!ok) {
                // invalid_grant: the sign-in was revoked, expired or replaced; only signing in again helps.
                if (json.optString("error") == "invalid_grant") throw Google.NeedsSignIn(null)
                throw Exception("Google: " + json.optString("error_description", json.optString("error", "HTTP ${c.responseCode}")))
            }
            Tokens(json.getString("access_token"), json.optString("refresh_token").ifEmpty { null }, json.optLong("expires_in", 3600))
        } finally {
            c.disconnect()
        }
    }
}
