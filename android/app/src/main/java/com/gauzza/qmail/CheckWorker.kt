package com.gauzza.qmail

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * Checks INBOX for messages newer than the last one we told the user about, and posts one
 * notification for them. Runs every 15 minutes (Android's floor for periodic work) when online.
 */
class CheckWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        val ctx = applicationContext
        var retry = false
        for (account in Accounts.all(ctx)) {
            if (account.auth == Auth.MICROSOFT) continue
            try {
                val key = account.key
                val (validity, fresh) = Mail.inbox(account, Accounts.secret(ctx, account)) { f ->
                    val validity = f.uidValidity
                    if (validity != SyncState.validity(ctx, key) || SyncState.lastUid(ctx, key) == 0L) {
                        // First run, or the server renumbered the folder: set a baseline, don't notify.
                        SyncState.set(ctx, key, validity, f.uidNext - 1)
                        validity to emptyList()
                    } else {
                        validity to Mail.newer(f, SyncState.lastUid(ctx, key))
                    }
                }
                if (fresh.isNotEmpty()) {
                    SyncState.advance(ctx, key, validity, fresh.maxOf { it.uid })
                    Notify.newMail(ctx, account, fresh.filterNot { it.seen })
                }
                Log.i(TAG, "checked ${account.email}: ${fresh.size} new")
            } catch (e: Google.NeedsSignIn) {
                // Retrying won't help until the user opens the app and signs in again.
                Log.w(TAG, "Google needs sign-in for ${account.email}")
                Notify.signInAgain(ctx, account)
            } catch (e: com.google.android.gms.common.api.ApiException) {
                // Usually: this Google account isn't on the phone. The app says so; retrying won't help.
                Log.w(TAG, "Google can't give a token for ${account.email}: ${e.statusCode}")
            } catch (e: Accounts.MissingPassword) {
                Log.w(TAG, "no password for ${account.email}")
            } catch (e: Exception) {
                Log.w(TAG, "check failed for ${account.email}", e)
                retry = true
            }
        }
        return if (retry) Result.retry() else Result.success()
    }

    companion object {
        private const val TAG = "QmailCheck"
        private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        fun schedule(ctx: Context) {
            val req = PeriodicWorkRequestBuilder<CheckWorker>(15, TimeUnit.MINUTES).setConstraints(online).build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork("check", ExistingPeriodicWorkPolicy.KEEP, req)
        }

        fun runNow(ctx: Context) {
            val req = OneTimeWorkRequestBuilder<CheckWorker>().setConstraints(online).build()
            WorkManager.getInstance(ctx).enqueueUniqueWork("check-now", ExistingWorkPolicy.REPLACE, req)
        }

        fun cancel(ctx: Context) {
            WorkManager.getInstance(ctx).cancelUniqueWork("check")
        }
    }
}

object Notify {
    private const val CHANNEL = "new_mail"
    /** One notification per mailbox, so several accounts don't overwrite each other. */
    private fun id(a: Account) = a.key.hashCode() and 0x3fffffff

    private fun channel(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "New mail", NotificationManager.IMPORTANCE_DEFAULT))
    }

    fun allowed(ctx: Context) = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun newMail(ctx: Context, account: Account, msgs: List<Msg>) {
        if (msgs.isEmpty() || !allowed(ctx)) return
        channel(ctx)
        val open = PendingIntent.getActivity(
            ctx, id(account),
            Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val top = msgs.first()
        val who = { m: Msg -> m.fromName.ifBlank { m.fromAddr } }
        val b = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setNumber(msgs.size)
            .setSubText(account.email)
        if (msgs.size == 1) {
            b.setContentTitle(who(top)).setContentText(top.subject)
        } else {
            val style = NotificationCompat.InboxStyle()
            msgs.take(6).forEach { style.addLine("${who(it)}  ${it.subject}") }
            b.setContentTitle("${msgs.size} new emails").setContentText("${who(top)}: ${top.subject}").setStyle(style)
        }
        @Suppress("MissingPermission")
        NotificationManagerCompat.from(ctx).notify(id(account), b.build())
    }

    fun signInAgain(ctx: Context, account: Account) {
        if (!allowed(ctx)) return
        channel(ctx)
        val open = PendingIntent.getActivity(
            ctx, id(account) xor 0x40000000, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_notify).setContentIntent(open).setAutoCancel(true)
            .setContentTitle("Sign in to Google again")
            .setContentText("Qmail can't check ${account.email} until you do.")
            .build()
        @Suppress("MissingPermission")
        NotificationManagerCompat.from(ctx).notify(id(account) xor 0x40000000, n)
    }

    fun clear(ctx: Context) = NotificationManagerCompat.from(ctx).cancelAll()
}
