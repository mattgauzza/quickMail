package com.gauzza.qmail

import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.zip.GZIPInputStream
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * Reads the code the desktop app shows under Settings → Phone (src/core/transfer.ts there):
 * QMX1:<base64url(salt[16] | iv[12] | AES-256-GCM(gzip(JSON)) | tag[16])>, keyed by PBKDF2-SHA256 of the passphrase.
 */
object Transfer {
    const val PREFIX = "QMX1:"
    private const val ROUNDS = 600_000

    class NotACode : Exception("That QR code isn't from Qmail on a computer. On the computer, open Settings, then Phone.")
    class WrongPassphrase : Exception("That passphrase doesn't match this code. Check the words on the computer screen.")

    /** One mailbox from the computer. [password] is null for Google and Microsoft mailboxes. */
    data class Incoming(val account: Account, val password: String?)

    fun looksRight(code: String) = code.trim().startsWith(PREFIX)

    fun normalize(p: String) = p.trim().lowercase().split(Regex("[\\s\\-_.,]+")).filter { it.isNotEmpty() }.joinToString(" ")

    suspend fun open(code: String, passphrase: String): List<Incoming> = withContext(Dispatchers.Default) {
        if (!looksRight(code)) throw NotACode()
        val raw = runCatching { Base64.decode(code.trim().removePrefix(PREFIX), Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP) }
            .getOrElse { throw NotACode() }
        if (raw.size < 16 + 12 + 16) throw NotACode()
        val salt = raw.copyOfRange(0, 16)
        val iv = raw.copyOfRange(16, 28)
        val sealed = raw.copyOfRange(28, raw.size)
        val spec = PBEKeySpec(normalize(passphrase).toCharArray(), salt, ROUNDS, 256)
        val key = SecretKeySpec(SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded, "AES")
        val plain = try {
            Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
                doFinal(sealed)
            }
        } catch (e: AEADBadTagException) {
            throw WrongPassphrase()
        }
        val json = JSONObject(GZIPInputStream(plain.inputStream()).bufferedReader().readText())
        val list = json.getJSONArray("a")
        (0 until list.length()).map { i ->
            val o = list.getJSONObject(i)
            val email = o.getString("e")
            val auth = when (o.optString("k")) { "google" -> Auth.GOOGLE; "microsoft" -> Auth.MICROSOFT; else -> Auth.PASSWORD }
            Incoming(
                Account(
                    email = email,
                    host = o.getString("ih"),
                    port = o.optInt("ip", 993),
                    // The desktop app's "not secure" IMAP setting upgrades with STARTTLS when the server offers it.
                    // (2 = no encryption at all, which only test servers use.)
                    security = when (o.optInt("is", 1)) { 1 -> Security.SSL; 2 -> Security.NONE; else -> Security.STARTTLS },
                    user = o.optString("u").ifEmpty { email },
                    auth = auth,
                    smtpHost = o.optString("sh"),
                    smtpPort = o.optInt("sp", 465),
                    smtpSsl = o.optInt("ss", 1) == 1,
                ),
                o.optString("p").ifEmpty { null },
            )
        }
    }
}
