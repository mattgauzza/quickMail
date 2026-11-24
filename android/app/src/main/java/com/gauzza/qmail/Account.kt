package com.gauzza.qmail

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

enum class Security { SSL, STARTTLS, NONE }

/** How the account logs in: a stored password, or a token fetched when needed. Microsoft isn't on the phone yet. */
enum class Auth { PASSWORD, GOOGLE, MICROSOFT }

data class Account(
    val email: String,
    val host: String,
    val port: Int,
    val security: Security,
    val user: String,
    val auth: Auth = Auth.PASSWORD,
    /** Outgoing server, kept for sending later. Empty when unknown. */
    val smtpHost: String = "",
    val smtpPort: Int = 465,
    val smtpSsl: Boolean = true,
) {
    /** Accounts are keyed by address, lower-cased. */
    val key: String get() = email.lowercase()
}

/** Guesses the IMAP server from the address, for the common providers. */
fun guessImap(email: String): Pair<String, Int> {
    val domain = email.substringAfter('@', "").lowercase()
    val host = when (domain) {
        "gmail.com", "googlemail.com" -> "imap.gmail.com"
        "outlook.com", "hotmail.com", "live.com", "msn.com" -> "outlook.office365.com"
        "icloud.com", "me.com", "mac.com" -> "imap.mail.me.com"
        "yahoo.com" -> "imap.mail.yahoo.com"
        "aol.com" -> "imap.aol.com"
        "fastmail.com" -> "imap.fastmail.com"
        else -> if (domain.isEmpty()) "" else "imap.$domain"
    }
    return host to 993
}

/** Every mailbox on the phone. Settings live in app-private prefs; each password is sealed with the Keystore. */
object Accounts {
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("account", Context.MODE_PRIVATE)

    private fun toJson(a: Account) = JSONObject()
        .put("email", a.email).put("host", a.host).put("port", a.port).put("security", a.security.name)
        .put("user", a.user).put("auth", a.auth.name)
        .put("smtpHost", a.smtpHost).put("smtpPort", a.smtpPort).put("smtpSsl", a.smtpSsl)

    private fun fromJson(o: JSONObject) = Account(
        email = o.getString("email"), host = o.getString("host"), port = o.getInt("port"),
        security = Security.valueOf(o.getString("security")), user = o.getString("user"),
        auth = Auth.valueOf(o.optString("auth", Auth.PASSWORD.name)),
        smtpHost = o.optString("smtpHost"), smtpPort = o.optInt("smtpPort", 465), smtpSsl = o.optBoolean("smtpSsl", true),
    )

    fun all(ctx: Context): List<Account> {
        migrate(ctx)
        val raw = prefs(ctx).getString("list", null) ?: return emptyList()
        return runCatching { JSONArray(raw).let { arr -> (0 until arr.length()).map { fromJson(arr.getJSONObject(it)) } } }
            .getOrDefault(emptyList())
    }

    fun find(ctx: Context, key: String) = all(ctx).firstOrNull { it.key == key.lowercase() }

    private fun write(ctx: Context, list: List<Account>) {
        val arr = JSONArray().also { a -> list.forEach { a.put(toJson(it)) } }
        prefs(ctx).edit().putString("list", arr.toString()).apply()
    }

    /** Version 0.1 kept one account in flat keys. Move it into the list once. */
    private fun migrate(ctx: Context) {
        val p = prefs(ctx)
        val email = p.getString("email", null) ?: return
        val a = Account(
            email = email, host = p.getString("host", "")!!, port = p.getInt("port", 993),
            security = Security.valueOf(p.getString("security", Security.SSL.name)!!), user = p.getString("user", email)!!,
            auth = Auth.valueOf(p.getString("auth", Auth.PASSWORD.name)!!),
        )
        val secret = p.getString("secret", null)
        p.edit().clear().putString("list", JSONArray().put(toJson(a)).toString())
            .apply { if (secret != null) putString("secret:${a.key}", secret) }.commit()
        SyncState.migrate(ctx, a.key)
    }

    /** Qmail's Google client (from the computer), for Gmail without the Google account on the phone. */
    data class GoogleClient(val id: String, val secret: String)

    fun googleClient(ctx: Context): GoogleClient? = prefs(ctx).getString("google-client", null)?.let { sealed ->
        runCatching { JSONObject(Secrets.open(sealed)).let { GoogleClient(it.getString("i"), it.getString("s")) } }.getOrNull()
    }

    fun saveGoogleClient(ctx: Context, c: GoogleClient) {
        prefs(ctx).edit().putString("google-client", Secrets.seal(JSONObject().put("i", c.id).put("s", c.secret).toString())).apply()
    }

    /** The saved password; for a Google mailbox, its refresh token (none when Play services signs it in). */
    fun password(ctx: Context, a: Account): String? =
        prefs(ctx).getString("secret:${a.key}", null)?.let { runCatching { Secrets.open(it) }.getOrNull() }

    /** Adds or replaces an account. [password] is a Google mailbox's refresh token, or null when Play services signs it in. */
    fun save(ctx: Context, a: Account, password: String?) {
        val list = all(ctx)
        write(ctx, if (list.any { it.key == a.key }) list.map { if (it.key == a.key) a else it } else list + a)
        prefs(ctx).edit().apply {
            if (password != null) putString("secret:${a.key}", Secrets.seal(password)) else remove("secret:${a.key}")
        }.apply()
    }

    class MissingPassword(email: String) : Exception("There's no saved password for $email. Remove it and add it again.")
    class NotOnPhone(email: String) : Exception("Microsoft mailboxes like $email can't be read on the phone yet.")

    /** What IMAP gets as the password: the saved one, or a fresh Google access token. */
    suspend fun secret(ctx: Context, a: Account): String = when (a.auth) {
        Auth.PASSWORD -> password(ctx, a) ?: throw MissingPassword(a.email)
        Auth.GOOGLE -> Google.token(ctx, a)
        Auth.MICROSOFT -> throw NotOnPhone(a.email)
    }

    fun remove(ctx: Context, a: Account) {
        write(ctx, all(ctx).filterNot { it.key == a.key })
        prefs(ctx).edit().remove("secret:${a.key}").apply()
        SyncState.clear(ctx, a.key)
        Boxes.clear(ctx, a.key)
    }
}

/** AES-GCM with a key that never leaves the Android Keystore. */
object Secrets {
    private const val ALIAS = "qmail-secrets"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build()
        )
        return gen.generateKey()
    }

    fun seal(plain: String): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        val b64 = { b: ByteArray -> Base64.encodeToString(b, Base64.NO_WRAP) }
        return b64(c.iv) + ":" + b64(c.doFinal(plain.toByteArray()))
    }

    fun open(sealed: String): String {
        val (iv, data) = sealed.split(':').map { Base64.decode(it, Base64.NO_WRAP) }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        return String(c.doFinal(data))
    }
}

/** What the background check has already told the user about, per account's INBOX. */
object SyncState {
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("sync", Context.MODE_PRIVATE)
    fun validity(ctx: Context, key: String) = prefs(ctx).getLong("validity:$key", 0)
    fun lastUid(ctx: Context, key: String) = prefs(ctx).getLong("lastUid:$key", 0)
    fun set(ctx: Context, key: String, validity: Long, lastUid: Long) =
        prefs(ctx).edit().putLong("validity:$key", validity).putLong("lastUid:$key", lastUid).apply()
    fun clear(ctx: Context, key: String) = prefs(ctx).edit().remove("validity:$key").remove("lastUid:$key").apply()

    /** Marks everything up to [uid] as seen, so the notifier never repeats what the list showed. */
    fun advance(ctx: Context, key: String, validity: Long, uid: Long) {
        if (validity != validity(ctx, key) || uid > lastUid(ctx, key)) set(ctx, key, validity, uid)
    }

    /** 0.1 kept one account's state under plain keys. */
    fun migrate(ctx: Context, key: String) {
        val p = prefs(ctx)
        if (!p.contains("lastUid")) return
        val v = p.getLong("validity", 0); val u = p.getLong("lastUid", 0)
        p.edit().remove("validity").remove("lastUid").putLong("validity:$key", v).putLong("lastUid:$key", u).apply()
    }
}
