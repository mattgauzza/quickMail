package com.gauzza.qmail

import android.Manifest
import android.content.Context
import android.os.Build
import android.text.format.DateUtils
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

// Same palette as the desktop app (src/renderer/src/styles.css), so both feel like one product.
private val LightColors = lightColorScheme(
    primary = Color(0xFF0B57D0), onPrimary = Color.White,
    primaryContainer = Color(0xFFD3E3FD), onPrimaryContainer = Color(0xFF041E49),
    secondaryContainer = Color(0xFFC2E7FF), onSecondaryContainer = Color(0xFF001D35),
    background = Color(0xFFF6F8FC), onBackground = Color(0xFF1F1F1F),
    surface = Color(0xFFF6F8FC), onSurface = Color(0xFF1F1F1F),
    surfaceContainerLowest = Color.White, surfaceContainerLow = Color(0xFFF2F6FC),
    surfaceContainer = Color(0xFFEAF1FB), surfaceContainerHigh = Color(0xFFE9ECF1),
    surfaceContainerHighest = Color(0xFFE1E5EA),
    onSurfaceVariant = Color(0xFF5F6368), outline = Color(0xFF8E918F), outlineVariant = Color(0xFFE4E7EB),
    error = Color(0xFFB3261E), errorContainer = Color(0xFFFCE8E6), onErrorContainer = Color(0xFF8C1D18),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFFA8C7FA), onPrimary = Color(0xFF062E6F),
    primaryContainer = Color(0xFF2F3B52), onPrimaryContainer = Color(0xFFD3E3FD),
    secondaryContainer = Color(0xFF004A77), onSecondaryContainer = Color(0xFFC2E7FF),
    background = Color(0xFF111418), onBackground = Color(0xFFE3E3E3),
    surface = Color(0xFF111418), onSurface = Color(0xFFE3E3E3),
    surfaceContainerLowest = Color(0xFF1F2328), surfaceContainerLow = Color(0xFF15181C),
    surfaceContainer = Color(0xFF1B1E22), surfaceContainerHigh = Color(0xFF25292E),
    surfaceContainerHighest = Color(0xFF2C3036),
    onSurfaceVariant = Color(0xFF9AA0A6), outline = Color(0xFF5F6368), outlineVariant = Color(0xFF2C3036),
    error = Color(0xFFF2B8B5), errorContainer = Color(0xFF3C1F1E), onErrorContainer = Color(0xFFF9DEDC),
)

@Composable
fun QmailTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors, content = content)
}

// Folder icons: the same Material paths the desktop app draws (src/renderer/src/lib.tsx).
private fun pathIcon(name: String, d: String) = ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f)
    .addPath(PathParser().parsePathString(d).toNodes(), fill = SolidColor(Color.Black)).build()

private object Glyph {
    val inbox = pathIcon("inbox", "M19 3H4.99c-1.11 0-1.98.89-1.98 2L3 19c0 1.1.88 2 1.99 2H19c1.1 0 2-.9 2-2V5c0-1.11-.9-2-2-2zm0 12h-4c0 1.66-1.35 3-3 3s-3-1.34-3-3H4.99V5H19v10z")
    val star = pathIcon("star", "M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z")
    val sent = pathIcon("sent", "M2.01 21L23 12 2.01 3 2 10l15 2-15 2z")
    val drafts = pathIcon("drafts", "M6 2c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6H6zm7 7V3.5L18.5 9H13z")
    val archive = pathIcon("archive", "M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z")
    val all = pathIcon("all", "M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z")
    val junk = pathIcon("junk", "M15.73 3H8.27L3 8.27v7.46L8.27 21h7.46L21 15.73V8.27L15.73 3zM12 17.3c-.72 0-1.3-.58-1.3-1.3 0-.72.58-1.3 1.3-1.3.72 0 1.3.58 1.3 1.3 0 .72-.58 1.3-1.3 1.3zm1-4.3h-2V7h2v6z")
    val trash = pathIcon("trash", "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z")
    val read = pathIcon("read", "M21.99 8c0-.72-.37-1.35-.94-1.7L12 1 2.95 6.3C2.38 6.65 2 7.28 2 8v10c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2l-.01-10zM12 13L3.74 7.84 12 3l8.26 4.84L12 13z")
    val qr = pathIcon("qr", "M9.5 6.5v3h-3v-3h3M11 5H5v6h6V5zm-1.5 9.5v3h-3v-3h3M11 13H5v6h6v-6zm6.5-6.5v3h-3v-3h3M19 5h-6v6h6V5zm-6 8h1.5v1.5H13V13zm1.5 1.5H16V16h-1.5v-1.5zM16 13h1.5v1.5H16V13zm-3 3h1.5v1.5H13V16zm1.5 1.5H16V19h-1.5v-1.5zM16 16h1.5v1.5H16V16zm1.5-1.5H19V16h-1.5v-1.5zm0 3H19V19h-1.5v-1.5zM22 7h-2V4h-3V2h5v5zm0 15v-5h-2v3h-3v2h5zM2 22h5v-2H4v-3H2v5zM2 2v5h2V4h3V2H2z")
    val folder = pathIcon("folder", "M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z")
}

private fun roleIcon(role: String?) = when (role) {
    "inbox" -> Glyph.inbox; "starred" -> Glyph.star; "sent" -> Glyph.sent; "drafts" -> Glyph.drafts
    "archive" -> Glyph.archive; "all" -> Glyph.all; "junk" -> Glyph.junk; "trash" -> Glyph.trash
    else -> Glyph.folder
}

/** The colour that marks a mailbox (its avatar's colour). */
fun accountColor(key: String) = avatarColors[(key.lowercase().hashCode() and 0x7fffffff) % avatarColors.size]

private val avatarColors = listOf(
    0xFF1A73E8, 0xFFD93025, 0xFF188038, 0xFFE37400, 0xFF9334E6, 0xFF007B83, 0xFFC5221F, 0xFF3949AB, 0xFF00897B, 0xFF8E24AA,
).map { Color(it) }

/** A coloured circle with the sender's initial; the colour stays the same for the same address. */
@Composable
fun Avatar(name: String, key: String, size: Dp = 40.dp) {
    val color = avatarColors[(key.lowercase().hashCode() and 0x7fffffff) % avatarColors.size]
    val letter = name.firstOrNull { it.isLetterOrDigit() }?.uppercase() ?: "?"
    Box(Modifier.size(size).clip(CircleShape).background(color), contentAlignment = Alignment.Center) {
        Text(letter, color = Color.White, fontWeight = FontWeight.Medium, fontSize = (size.value * 0.42f).sp)
    }
}

@Composable
fun QmailApp(model: AppModel = viewModel()) {
    // Fetch the inbox each time the app comes to the front.
    LifecycleResumeEffect(Unit) {
        model.refresh()
        onPauseOrDispose {}
    }
    val list = rememberLazyListState()
    if (model.accounts.isEmpty() || model.adding) {
        SetupScreen(model)
        return
    }
    val snackHost = remember { SnackbarHostState() }
    LaunchedEffect(model.snack) {
        val s = model.snack ?: return@LaunchedEffect
        val r = snackHost.showSnackbar(s.text, s.undo?.let { "Undo" }, duration = SnackbarDuration.Short)
        if (r == SnackbarResult.ActionPerformed) s.undo?.invoke()
        if (model.snack === s) model.snack = null
    }
    model.doomed?.let { m ->
        AlertDialog(
            onDismissRequest = { model.doomed = null },
            title = { Text("Delete forever?") },
            text = { Text("\"${m.subject.ifBlank { "(no subject)" }}\" will be removed from the server. This can't be undone.") },
            confirmButton = {
                TextButton(onClick = { model.doomed = null; model.destroy(m) }) {
                    Text("Delete forever", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { model.doomed = null }) { Text("Cancel") } },
        )
    }
    Box(Modifier.fillMaxSize()) {
    AnimatedContent(
        targetState = model.open,
        transitionSpec = {
            if (targetState != null) (slideInHorizontally { it / 5 } + fadeIn()) togetherWith fadeOut()
            else fadeIn() togetherWith (slideOutHorizontally { it / 5 } + fadeOut())
        },
        label = "screen",
    ) { open ->
        if (open == null) InboxScreen(model, list)
        else {
            BackHandler { model.open = null }
            ReaderScreen(model, open, model.body) { model.open = null }
        }
    }
    SnackbarHost(snackHost, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(12.dp))
    }
}

// ---------- Setup ----------

@Composable
fun SetupScreen(model: AppModel) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var more by remember { mutableStateOf(false) }
    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf("993") }
    var security by remember { mutableStateOf(Security.SSL) }
    var user by remember { mutableStateOf("") }
    var busyGoogle by remember { mutableStateOf(false) }
    var busyPassword by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val busy = busyGoogle || busyPassword
    val scope = rememberCoroutineScope()
    val google = rememberGoogleSignIn { result, err ->
        if (result == null) { error = err; busyGoogle = false }
        else scope.launch { error = model.googleSignedIn(result); busyGoogle = false }
    }
    // After an import the inbox takes over, so its summary goes to the snackbar there.
    val importer = rememberDesktopImport(model) { msg -> if (model.accounts.isEmpty()) error = msg else model.snack = AppModel.Snack(msg) }

    // Until the user edits the server fields, keep them following the address.
    var hostEdited by remember { mutableStateOf(false) }
    LaunchedEffect(email) {
        if (!hostEdited) {
            val (h, p) = guessImap(email.trim())
            host = h; port = p.toString(); security = Security.SSL
        }
    }
    val field = RoundedCornerShape(14.dp)

    Scaffold(containerColor = MaterialTheme.colorScheme.background) { pad ->
        Column(
            Modifier.fillMaxSize().padding(pad).imePadding().verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (model.accounts.isNotEmpty()) {
                BackHandler { model.adding = false }
                Row(Modifier.fillMaxWidth().padding(top = 8.dp)) {
                    IconButton(onClick = { model.adding = false }, Modifier.offset(x = (-12).dp)) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                    }
                }
                Spacer(Modifier.height(8.dp))
            } else Spacer(Modifier.height(56.dp))
            Box(
                Modifier.size(76.dp).clip(RoundedCornerShape(22.dp)).background(MaterialTheme.colorScheme.primary),
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Default.Email, null, Modifier.size(38.dp), tint = MaterialTheme.colorScheme.onPrimary) }
            Spacer(Modifier.height(24.dp))
            Text("Welcome to Qmail", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(8.dp))
            Text(
                "Your mail comes straight from your provider to this phone. Nothing in between.",
                style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(36.dp))

            OutlinedButton(
                onClick = { busyGoogle = true; error = null; google(null) },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth().height(54.dp),
                shape = RoundedCornerShape(27.dp),
                colors = ButtonDefaults.outlinedButtonColors(
                    containerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
                    contentColor = MaterialTheme.colorScheme.onSurface,
                ),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.5f)),
            ) {
                if (busyGoogle) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                else {
                    Image(painterResource(R.drawable.ic_google), null, Modifier.size(20.dp))
                    Spacer(Modifier.width(12.dp))
                    Text("Continue with Google", style = MaterialTheme.typography.titleSmall)
                }
            }
            Spacer(Modifier.height(12.dp))
            OutlinedButton(
                onClick = { error = null; importer() },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth().height(54.dp),
                shape = RoundedCornerShape(27.dp),
                colors = ButtonDefaults.outlinedButtonColors(
                    containerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
                    contentColor = MaterialTheme.colorScheme.onSurface,
                ),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.5f)),
            ) {
                Icon(Glyph.qr, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.width(12.dp))
                Text("Import from computer", style = MaterialTheme.typography.titleSmall)
            }

            Row(Modifier.padding(vertical = 24.dp), verticalAlignment = Alignment.CenterVertically) {
                HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
                Text("or use a password", Modifier.padding(horizontal = 12.dp),
                    style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
            }

            Surface(
                color = MaterialTheme.colorScheme.surfaceContainerLowest,
                shape = RoundedCornerShape(24.dp),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
            ) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedTextField(
                        email, { email = it }, Modifier.fillMaxWidth(), label = { Text("Email address") },
                        leadingIcon = { Icon(Icons.Default.Email, null) }, singleLine = true, shape = field,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                    )
                    OutlinedTextField(
                        password, { password = it }, Modifier.fillMaxWidth(), label = { Text("Password or app password") },
                        leadingIcon = { Icon(Icons.Default.Lock, null) }, singleLine = true, shape = field,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    )
                    val domain = email.substringAfter('@', "").lowercase()
                    if (domain in setOf("gmail.com", "googlemail.com", "icloud.com", "me.com", "yahoo.com")) {
                        Text(
                            if (domain.startsWith("g")) "For Gmail, Continue with Google is easier. A password here must be an app password."
                            else "This provider needs an app password, not your normal one.",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    val turn by animateFloatAsState(if (more) 180f else 0f, label = "arrow")
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { more = !more }
                            .padding(vertical = 8.dp, horizontal = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("Server settings", Modifier.weight(1f), style = MaterialTheme.typography.labelLarge,
                            color = MaterialTheme.colorScheme.primary)
                        if (host.isNotBlank() && !more) Text(host, style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(end = 6.dp).weight(1f, fill = false))
                        Icon(Icons.Default.KeyboardArrowDown, null, Modifier.rotate(turn), tint = MaterialTheme.colorScheme.primary)
                    }
                    AnimatedVisibility(more, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
                        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            OutlinedTextField(host, { host = it; hostEdited = true }, Modifier.fillMaxWidth(),
                                label = { Text("IMAP server") }, singleLine = true, shape = field)
                            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                                OutlinedTextField(
                                    port, { port = it.filter(Char::isDigit); hostEdited = true }, Modifier.width(96.dp),
                                    label = { Text("Port") }, singleLine = true, shape = field,
                                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                                )
                                SingleChoiceSegmentedButtonRow(Modifier.weight(1f)) {
                                    Security.entries.forEachIndexed { i, s ->
                                        SegmentedButton(
                                            selected = security == s,
                                            onClick = {
                                                security = s; hostEdited = true
                                                port = if (s == Security.SSL) "993" else "143"
                                            },
                                            shape = SegmentedButtonDefaults.itemShape(i, Security.entries.size),
                                            icon = {},
                                        ) {
                                            Text(when (s) { Security.SSL -> "SSL"; Security.STARTTLS -> "TLS"; Security.NONE -> "None" },
                                                maxLines = 1)
                                        }
                                    }
                                }
                            }
                            OutlinedTextField(user, { user = it }, Modifier.fillMaxWidth(),
                                label = { Text("Username, if not the address") }, singleLine = true, shape = field)
                        }
                    }
                }
            }

            AnimatedVisibility(error != null) {
                Surface(
                    color = MaterialTheme.colorScheme.errorContainer, shape = RoundedCornerShape(14.dp),
                    modifier = Modifier.padding(top = 16.dp).fillMaxWidth(),
                ) {
                    Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Warning, null, tint = MaterialTheme.colorScheme.onErrorContainer)
                        Spacer(Modifier.width(12.dp))
                        Text(error.orEmpty(), color = MaterialTheme.colorScheme.onErrorContainer,
                            style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }

            Spacer(Modifier.height(20.dp))
            Button(
                enabled = !busy && email.contains('@') && password.isNotEmpty() && host.isNotBlank(),
                onClick = {
                    busyPassword = true; error = null
                    val a = Account(
                        email = email.trim(), host = host.trim(), port = port.toIntOrNull() ?: 993,
                        security = security, user = user.trim().ifEmpty { email.trim() },
                    )
                    scope.launch { error = model.signIn(a, password); busyPassword = false }
                },
                modifier = Modifier.fillMaxWidth().height(54.dp),
                shape = RoundedCornerShape(27.dp),
            ) {
                if (busyPassword) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onPrimary)
                else Text("Sign in", style = MaterialTheme.typography.titleSmall)
            }
            Spacer(Modifier.height(32.dp))
        }
    }
}

// ---------- Inbox ----------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InboxScreen(model: AppModel, list: LazyListState) {
    val ctx = LocalContext.current
    var menu by remember { mutableStateOf(false) }
    var removing by remember { mutableStateOf<Account?>(null) }
    val scope = rememberCoroutineScope()
    val google = rememberGoogleSignIn { result, err ->
        if (result == null) model.showError(err)
        else scope.launch { model.googleSignedIn(result)?.let(model::showError) }
    }
    val importer = rememberDesktopImport(model) { model.snack = AppModel.Snack(it) }
    val notifyPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    LaunchedEffect(Unit) {
        // Ask once per install; after that the user changes it in system settings.
        val prefs = ctx.getSharedPreferences("ui", Context.MODE_PRIVATE)
        if (Build.VERSION.SDK_INT >= 33 && !prefs.getBoolean("askedNotify", false) && !Notify.allowed(ctx)) {
            prefs.edit().putBoolean("askedNotify", true).apply()
            notifyPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
    val here = model.accountOf(model.view.account)
    val many = model.accounts.size > 1
    val unread = model.messages.count { !it.seen }
    val drawer = rememberDrawerState(DrawerValue.Closed)
    var sheetFor by remember { mutableStateOf<Msg?>(null) }
    sheetFor?.let { m -> ActionSheet(model, m) { sheetFor = null } }
    BackHandler(drawer.isOpen) { scope.launch { drawer.close() } }
    // Back from another folder returns to the inbox before it leaves the app, as in Gmail.
    BackHandler(!drawer.isOpen && model.view != Place()) { model.select(Place()) }
    removing?.let { a ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text("Remove ${a.email}?") },
            text = { Text("Its mail leaves this phone. Nothing is deleted on the server, and you can add it again.") },
            confirmButton = { TextButton(onClick = { removing = null; model.remove(a.key) }) { Text("Remove") } },
            dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } },
        )
    }

    ModalNavigationDrawer(
        drawerState = drawer,
        drawerContent = {
            MailDrawer(
                model,
                pick = { place ->
                    scope.launch { drawer.close() }
                    model.select(place)
                    scope.launch { list.scrollToItem(0) }
                },
                add = { scope.launch { drawer.close() }; model.adding = true },
                import = { scope.launch { drawer.close() }; importer() },
            )
        },
    ) {
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            Row(
                Modifier.fillMaxWidth().statusBarsPadding().padding(start = 4.dp, end = 12.dp, top = 12.dp, bottom = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = { scope.launch { drawer.open() } }) { Icon(Icons.Default.Menu, "Folders") }
                Spacer(Modifier.width(4.dp))
                Column(Modifier.weight(1f)) {
                    Text(model.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
                    Text(
                        listOfNotNull(
                            if (many) here?.email else null,
                            when {
                                model.loading -> "Checking for mail…"
                                unread > 0 -> "$unread unread"
                                else -> "All read"
                            },
                        ).joinToString(" · "),
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
                IconButton(onClick = { model.refresh() }, enabled = !model.loading) {
                    Icon(Icons.Default.Refresh, "Refresh", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Box {
                    val who = (here ?: model.accounts.firstOrNull())?.email.orEmpty()
                    IconButton(onClick = { menu = true }) { Avatar(who, who, 34.dp) }
                    DropdownMenu(menu, { menu = false }, shape = RoundedCornerShape(16.dp),
                        containerColor = MaterialTheme.colorScheme.surfaceContainerLowest) {
                        model.accounts.forEach { a ->
                            Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                                Avatar(a.email, a.email, 28.dp)
                                Spacer(Modifier.width(12.dp))
                                Text(a.email, Modifier.weight(1f, fill = false), style = MaterialTheme.typography.bodyMedium,
                                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                                IconButton(onClick = { menu = false; removing = a }) {
                                    Icon(Icons.AutoMirrored.Filled.ExitToApp, "Remove ${a.email} from this phone",
                                        tint = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                        HorizontalDivider(Modifier.padding(vertical = 4.dp), color = MaterialTheme.colorScheme.outlineVariant)
                        DropdownMenuItem(
                            text = { Text("Add mailbox") },
                            leadingIcon = { Icon(Icons.Default.Add, null) },
                            onClick = { menu = false; model.adding = true },
                        )
                        DropdownMenuItem(
                            text = { Text("Import from computer") },
                            leadingIcon = { Icon(Glyph.qr, null) },
                            onClick = { menu = false; importer() },
                        )
                        DropdownMenuItem(
                            text = { Text("Run background check now") },
                            leadingIcon = { Icon(Icons.Default.Notifications, null) },
                            onClick = { menu = false; model.checkNow() },
                        )
                    }
                }
            }
        },
    ) { pad ->
        PullToRefreshBox(model.loading, { model.refresh() }, Modifier.padding(pad).fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = 24.dp)) {
                val shown = model.problems.filterKeys { model.view.account == null || it == model.view.account }
                if (model.error != null || shown.isNotEmpty()) {
                    item(key = "error") {
                        Surface(
                            color = MaterialTheme.colorScheme.errorContainer, shape = RoundedCornerShape(16.dp),
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).fillMaxWidth(),
                        ) {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                model.error?.let { e -> Problem(null, e) }
                                shown.forEach { (key, text) ->
                                    val a = model.accountOf(key)
                                    Problem(a?.email.takeIf { many || model.error != null }, text)
                                    if (key in model.needsGoogle && a != null) {
                                        Button(onClick = { google(null) }, Modifier.padding(start = 36.dp)) {
                                            Text(if (many) "Sign in to ${a.email}" else "Sign in with Google", maxLines = 1,
                                                overflow = TextOverflow.Ellipsis)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                if (model.messages.isEmpty() && !model.loading && model.error == null && shown.isEmpty()) {
                    item(key = "empty") { EmptyInbox(if (model.view.folder == INBOX) null else model.title) }
                }
                items(model.messages, key = { it.id }) { m ->
                    SwipeRow(model, m, Modifier.animateItem(), showAccount = many && model.view.account == null,
                        onLongClick = { sheetFor = m }) { model.read(m) }
                }
            }
        }
    }
    }
}

@Composable
private fun Problem(email: String?, text: String) {
    Row(verticalAlignment = Alignment.Top) {
        Icon(Icons.Default.Warning, null, tint = MaterialTheme.colorScheme.onErrorContainer)
        Spacer(Modifier.width(12.dp))
        Column {
            if (email != null) Text(email, color = MaterialTheme.colorScheme.onErrorContainer,
                style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
            Text(text, color = MaterialTheme.colorScheme.onErrorContainer, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

/** All inboxes, then each mailbox with its folders (one opened at a time), then adding more. */
@Composable
private fun MailDrawer(model: AppModel, pick: (Place) -> Unit, add: () -> Unit, import: () -> Unit) {
    val many = model.accounts.size > 1
    var expanded by remember { mutableStateOf(model.view.account ?: model.accounts.firstOrNull()?.key) }
    ModalDrawerSheet(Modifier.width(312.dp), drawerContainerColor = MaterialTheme.colorScheme.surfaceContainerLow) {
        LazyColumn(contentPadding = PaddingValues(bottom = 16.dp)) {
            item(key = "head") {
                Row(Modifier.padding(start = 24.dp, end = 20.dp, top = 24.dp, bottom = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier.size(36.dp).clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.primary),
                        contentAlignment = Alignment.Center,
                    ) { Icon(Icons.Default.Email, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onPrimary) }
                    Spacer(Modifier.width(12.dp))
                    Column {
                        Text("Qmail", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                        Text(
                            if (many) "${model.accounts.size} mailboxes" else model.accounts.firstOrNull()?.email.orEmpty(),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
            if (many) {
                item(key = "all") {
                    val total = model.accounts.sumOf { a -> model.foldersOf(a.key).firstOrNull { it.role == "inbox" }?.unread ?: 0 }
                    FolderItem(Box(INBOX, "All inboxes", "inbox", total, 0), model.view == Place()) { pick(Place()) }
                    HorizontalDivider(Modifier.padding(horizontal = 28.dp, vertical = 8.dp), color = MaterialTheme.colorScheme.outlineVariant)
                }
            }
            model.accounts.forEach { a ->
                val open = !many || expanded == a.key
                if (many) item(key = "acct:${a.key}") {
                    AccountRow(model, a, open) { expanded = if (open) null else a.key }
                }
                if (open) {
                    val boxes = model.foldersOf(a.key).ifEmpty { listOf(Box(INBOX, "Inbox", "inbox", 0, 0)) }
                    items(boxes, key = { "${a.key}/${it.name}" }) { b ->
                        val selected = (model.view.account == a.key && model.view.folder == b.name) ||
                            (!many && model.view.account == null && b.name == INBOX)
                        FolderItem(b, selected, indent = if (many) 1 else 0) { pick(Place(a.key, b.name)) }
                    }
                }
            }
            item(key = "more") {
                HorizontalDivider(Modifier.padding(horizontal = 28.dp, vertical = 8.dp), color = MaterialTheme.colorScheme.outlineVariant)
                NavigationDrawerItem(
                    label = { Text("Add mailbox") }, selected = false, onClick = add,
                    icon = { Icon(Icons.Default.Add, null) },
                    modifier = Modifier.padding(horizontal = 12.dp).height(50.dp),
                )
                NavigationDrawerItem(
                    label = { Text("Import from computer") }, selected = false, onClick = import,
                    icon = { Icon(Glyph.qr, null) },
                    modifier = Modifier.padding(horizontal = 12.dp).height(50.dp),
                )
            }
        }
    }
}

@Composable
private fun AccountRow(model: AppModel, a: Account, open: Boolean, toggle: () -> Unit) {
    val turn by animateFloatAsState(if (open) 180f else 0f, label = "arrow")
    val unread = model.foldersOf(a.key).firstOrNull { it.role == "inbox" }?.unread ?: 0
    val problem = model.problems[a.key]
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp).clip(RoundedCornerShape(25.dp)).clickable(onClick = toggle)
            .padding(start = 16.dp, end = 12.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(a.email, a.email, 28.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(a.email, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                fontWeight = if (unread > 0) FontWeight.SemiBold else FontWeight.Normal)
            if (problem != null) Text(problem, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (unread > 0) Text("$unread", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
        Icon(Icons.Default.KeyboardArrowDown, if (open) "Hide folders" else "Show folders",
            Modifier.padding(start = 6.dp).rotate(turn), tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun FolderItem(b: Box, selected: Boolean, indent: Int = 0, pick: () -> Unit) {
    NavigationDrawerItem(
        label = {
            Text(b.label, maxLines = 1, overflow = TextOverflow.Ellipsis,
                fontWeight = if (b.unread > 0 || selected) FontWeight.SemiBold else FontWeight.Normal)
        },
        selected = selected,
        onClick = pick,
        icon = { Icon(roleIcon(b.role), null) },
        badge = {
            if (b.unread > 0) Text(if (b.unread > 999) "999+" else "${b.unread}",
                style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
        },
        modifier = Modifier.padding(start = 12.dp + ((b.depth + indent) * 16).dp, end = 12.dp).height(50.dp),
    )
}

/**
 * "Import from computer": scan the QR code from Settings → Phone in the desktop app, type its passphrase, and the
 * mailboxes are added. Google's code scanner does the camera work, so the app needs no camera permission.
 */
@Composable
fun rememberDesktopImport(model: AppModel, done: (String) -> Unit): () -> Unit {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var code by remember { mutableStateOf<String?>(null) }
    // Debug builds can take a code from the launch intent (adb ... --es qmx <code>), for testing without a camera.
    LaunchedEffect(Unit) {
        val debuggable = (ctx.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
        val act = ctx as? android.app.Activity
        val extra = act?.intent?.getStringExtra("qmx")
        if (debuggable && extra != null) { act.intent.removeExtra("qmx"); code = extra }
    }
    code?.let { c -> PassphraseDialog(model, c, onClose = { code = null }, done = { code = null; done(it) }) }
    return {
        scope.launch {
            try {
                val scanner = GmsBarcodeScanning.getClient(
                    ctx, GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build(),
                )
                val raw = scanner.startScan().await().rawValue.orEmpty()
                if (Transfer.looksRight(raw)) code = raw else done(Transfer.NotACode().message!!)
            } catch (e: kotlinx.coroutines.CancellationException) {
                // The user backed out of the scanner.
            } catch (e: Exception) {
                done("Couldn't open the QR scanner: ${e.message ?: e.javaClass.simpleName}")
            }
        }
    }
}

@Composable
private fun PassphraseDialog(model: AppModel, code: String, onClose: () -> Unit, done: (String) -> Unit) {
    var pass by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val go = {
        busy = true; error = null
        scope.launch {
            try { done(model.importFrom(Transfer.open(code, pass))) }
            catch (e: Exception) { error = e.message ?: "That didn't work." }
            busy = false
        }
    }
    AlertDialog(
        onDismissRequest = { if (!busy) onClose() },
        icon = { Icon(Glyph.qr, null) },
        title = { Text("Type the passphrase") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("It's the five words shown beside the QR code on your computer.",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedTextField(
                    pass, { pass = it; error = null }, Modifier.fillMaxWidth(), singleLine = true, enabled = !busy,
                    placeholder = { Text("five words") }, shape = RoundedCornerShape(12.dp), isError = error != null,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                )
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                if (busy) Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(10.dp))
                    Text("Unlocking…", style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = { TextButton(onClick = { go() }, enabled = !busy && pass.isNotBlank()) { Text("Add mailboxes") } },
        dismissButton = { TextButton(onClick = onClose, enabled = !busy) { Text("Cancel") } },
    )
}

@Composable
private fun EmptyInbox(folder: String?) {
    Column(Modifier.fillMaxWidth().padding(top = 120.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier.size(88.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primaryContainer),
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Default.Email, null, Modifier.size(40.dp), tint = MaterialTheme.colorScheme.onPrimaryContainer) }
        Spacer(Modifier.height(20.dp))
        Text(if (folder == null) "You're all caught up" else "Nothing in $folder",
            style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Text(if (folder == null) "New mail shows up here." else "Pull down to check again.", style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
@OptIn(ExperimentalFoundationApi::class)
fun MessageRow(m: Msg, modifier: Modifier = Modifier, showAccount: Boolean = false, onLongClick: () -> Unit = {}, onClick: () -> Unit) {
    val haptics = LocalHapticFeedback.current
    val unread = !m.seen
    val name = m.fromName.ifBlank { m.fromAddr.substringBefore('@') }.ifBlank { "Unknown sender" }
    Row(
        modifier.fillMaxWidth()
            .background(if (unread) MaterialTheme.colorScheme.surfaceContainerLowest else MaterialTheme.colorScheme.background)
            .combinedClickable(onClick = onClick, onLongClick = {
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                onLongClick()
            })
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Avatar(name, m.fromAddr.ifBlank { name })
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    name, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = if (unread) FontWeight.Bold else FontWeight.Normal,
                    color = if (unread) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.width(8.dp))
                // In All inboxes, a dot in the mailbox's colour says which account the mail is in.
                if (showAccount) Box(Modifier.padding(end = 6.dp).size(8.dp).clip(CircleShape).background(accountColor(m.account)))
                Text(
                    shortDate(LocalContext.current, m.date), style = MaterialTheme.typography.labelMedium,
                    fontWeight = if (unread) FontWeight.Bold else FontWeight.Normal,
                    color = if (unread) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(2.dp))
            Row(verticalAlignment = Alignment.Top) {
                Text(
                    m.subject.ifBlank { "(no subject)" }, Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Normal,
                    color = if (unread) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (unread) Box(Modifier.padding(start = 10.dp, top = 6.dp).size(9.dp).clip(CircleShape)
                    .background(MaterialTheme.colorScheme.primary))
            }
        }
    }
}

/** Swipe right to archive, left to delete, the way Gmail does. The change can be undone from the snackbar. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SwipeRow(model: AppModel, m: Msg, modifier: Modifier, showAccount: Boolean, onLongClick: () -> Unit, onClick: () -> Unit) {
    val canArchive = model.archiveBox(m) != null
    val state = rememberSwipeToDismissBoxState(
        confirmValueChange = { v ->
            when (v) {
                SwipeToDismissBoxValue.StartToEnd -> { model.archive(m); true }
                // Deleting for good asks first, so the row springs back until the user confirms.
                SwipeToDismissBoxValue.EndToStart -> { model.askDelete(m); !model.deletesForGood(m) }
                else -> false
            }
        },
        positionalThreshold = { it * 0.35f },
    )
    SwipeToDismissBox(
        state = state,
        modifier = modifier,
        enableDismissFromStartToEnd = canArchive,
        backgroundContent = {
            val dir = state.dismissDirection
            val archive = dir == SwipeToDismissBoxValue.StartToEnd
            if (dir == SwipeToDismissBoxValue.Settled) return@SwipeToDismissBox
            Row(
                Modifier.fillMaxSize().background(if (archive) Color(0xFF188038) else Color(0xFFD93025)).padding(horizontal = 24.dp),
                horizontalArrangement = if (archive) Arrangement.Start else Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(if (archive) Glyph.archive else Glyph.trash, null, tint = Color.White)
                Spacer(Modifier.width(12.dp))
                Text(if (archive) "Archive" else if (model.deletesForGood(m)) "Delete forever" else "Delete",
                    color = Color.White, style = MaterialTheme.typography.labelLarge)
            }
        },
    ) { MessageRow(m, showAccount = showAccount, onLongClick = onLongClick, onClick = onClick) }
}

/** What you can do with one email: from a long press in the list, or the reader's menu. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ActionSheet(model: AppModel, m: Msg, onDismiss: () -> Unit) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    var moving by remember { mutableStateOf(false) }
    val close = { act: () -> Unit -> act(); scope.launch { sheet.hide() }.invokeOnCompletion { onDismiss() } }
    val name = m.fromName.ifBlank { m.fromAddr.substringBefore('@') }.ifBlank { "Unknown sender" }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, containerColor = MaterialTheme.colorScheme.surfaceContainerLowest) {
        Row(Modifier.padding(start = 24.dp, end = 24.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Avatar(name, m.fromAddr.ifBlank { name }, 36.dp)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(name, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(m.subject.ifBlank { "(no subject)" }, style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        if (!moving) {
            if (model.archiveBox(m) != null) SheetItem(Glyph.archive, "Archive") { close { model.archive(m) } }
            SheetItem(if (m.seen) Glyph.all else Glyph.read, if (m.seen) "Mark as unread" else "Mark as read") {
                close { model.setSeen(m, !m.seen) }
            }
            SheetItem(Glyph.folder, "Move to…") { moving = true }
            SheetItem(Glyph.trash, if (model.deletesForGood(m)) "Delete forever" else "Delete", MaterialTheme.colorScheme.error) {
                close { model.askDelete(m) }
            }
        } else {
            Row(Modifier.fillMaxWidth().padding(start = 8.dp, end = 24.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { moving = false }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                Text("Move to", style = MaterialTheme.typography.titleMedium)
            }
            val targets = model.foldersOf(m.account).filter { it.name != m.folder && it.role !in setOf("starred", "drafts", "all") }
            if (targets.isEmpty()) Text("No other folders yet. Pull down in the list to load them.", Modifier.padding(24.dp),
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            LazyColumn(Modifier.heightIn(max = 440.dp)) {
                items(targets, key = { it.name }) { b -> SheetItem(roleIcon(b.role), b.label, indent = b.depth) { close { model.moveTo(m, b) } } }
            }
        }
        Spacer(Modifier.navigationBarsPadding().height(12.dp))
    }
}

@Composable
private fun SheetItem(
    icon: ImageVector, text: String, color: Color = Color.Unspecified, indent: Int = 0, onClick: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).height(56.dp).padding(start = 24.dp + (indent * 16).dp, end = 24.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = if (color == Color.Unspecified) MaterialTheme.colorScheme.onSurfaceVariant else color)
        Spacer(Modifier.width(20.dp))
        Text(text, style = MaterialTheme.typography.bodyLarge, color = if (color == Color.Unspecified) MaterialTheme.colorScheme.onSurface else color)
    }
}

private fun shortDate(ctx: Context, ms: Long): String =
    if (ms == 0L) "" else if (DateUtils.isToday(ms)) DateUtils.formatDateTime(ctx, ms, DateUtils.FORMAT_SHOW_TIME)
    else DateUtils.formatDateTime(ctx, ms, DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_ABBREV_MONTH)

// ---------- Reader ----------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReaderScreen(model: AppModel, m: Msg, body: String?, back: () -> Unit) {
    val name = m.fromName.ifBlank { m.fromAddr.substringBefore('@') }.ifBlank { "Unknown sender" }
    var sheet by remember { mutableStateOf(false) }
    if (sheet) ActionSheet(model, m) { sheet = false }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = {},
                navigationIcon = { IconButton(onClick = back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = {
                    if (model.archiveBox(m) != null) IconButton(onClick = { model.archive(m) }) { Icon(Glyph.archive, "Archive") }
                    IconButton(onClick = { model.askDelete(m) }) { Icon(Glyph.trash, "Delete") }
                    IconButton(onClick = { model.setSeen(m, false) }) { Icon(Glyph.all, "Mark as unread") }
                    IconButton(onClick = { sheet = true }) { Icon(Icons.Default.MoreVert, "More") }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp)) {
            Text(m.subject.ifBlank { "(no subject)" }, style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(20.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Avatar(name, m.fromAddr.ifBlank { name }, 44.dp)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(name, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (m.fromAddr.isNotBlank()) Text(m.fromAddr, style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Text(
                    if (m.date == 0L) "" else DateUtils.formatDateTime(LocalContext.current, m.date,
                        DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_SHOW_TIME or DateUtils.FORMAT_ABBREV_MONTH),
                    style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(20.dp))
            Surface(
                color = MaterialTheme.colorScheme.surfaceContainerLowest, shape = RoundedCornerShape(20.dp),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (body == null) {
                    Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp)
                    }
                } else {
                    SelectionContainer {
                        Text(body, Modifier.padding(18.dp), style = MaterialTheme.typography.bodyLarge, lineHeight = 24.sp)
                    }
                }
            }
            Spacer(Modifier.navigationBarsPadding().height(32.dp))
        }
    }
}
