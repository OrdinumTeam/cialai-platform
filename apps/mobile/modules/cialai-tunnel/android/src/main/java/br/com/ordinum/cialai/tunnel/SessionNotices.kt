// SPDX-License-Identifier: Apache-2.0
package br.com.ordinum.cialai.tunnel

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.os.Build
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

// Avisos das sessões no Android, com a imagem da sessão como ícone grande: o
// ícone dela em branco sobre a cor dela, desenhado pela página. O
// expo-notifications só aceita o ícone grande fixo do manifesto, por isso o
// aviso sai daqui. O toque abre o app com a sessão no Intent, que o módulo
// entrega ao TypeScript.
internal object SessionNotices {
  const val EXTRA_DESKTOP = "br.com.ordinum.cialai.notice.desktopId"
  const val EXTRA_SESSION = "br.com.ordinum.cialai.notice.sessionId"
  private const val NOTICE_ID = 0x5E55
  private const val MAX_IMAGE_BYTES = 96_000
  private val CHANNELS = setOf("activity", "attention")
  private val HEX = Regex("#[0-9a-fA-F]{6}")

  data class Notice(
    val tag: String,
    val channel: String,
    val channelName: String,
    val title: String,
    val body: String,
    val subtitle: String?,
    val color: Int?,
    val image: Bitmap?,
    val desktopId: String?,
    val sessionId: String?
  )

  fun parse(raw: Map<String, String>): Notice {
    fun text(key: String) = raw[key]?.takeIf { it.isNotEmpty() }
    val tag = text("tag") ?: throw IllegalArgumentException("notice_invalid: Aviso sem identificador.")
    val channel = text("channel")?.takeIf { it in CHANNELS } ?: "activity"
    return Notice(
      tag = tag.take(200),
      channel = channel,
      channelName = text("channelName") ?: "Cialai",
      title = text("title") ?: throw IllegalArgumentException("notice_invalid: Aviso sem título."),
      body = text("body") ?: "",
      subtitle = text("subtitle"),
      color = text("color")?.takeIf { HEX.matches(it) }?.let(Color::parseColor),
      image = text("image")?.let(::decodeImage),
      desktopId = text("desktopId"),
      sessionId = text("sessionId")
    )
  }

  // PNG base64 vindo da página; inválido ou grande demais vira aviso sem imagem.
  private fun decodeImage(base64: String): Bitmap? {
    if (base64.length > MAX_IMAGE_BYTES * 4 / 3 + 4) return null
    val bytes = runCatching { Base64.decode(base64, Base64.DEFAULT) }.getOrNull() ?: return null
    return runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size) }.getOrNull()
  }

  // `silent` vale com o app na tela, como o expo fazia: o aviso aparece sem som.
  fun present(context: Context, notice: Notice, silent: Boolean): Boolean {
    val manager = NotificationManagerCompat.from(context)
    if (!manager.areNotificationsEnabled()) return false
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
    ensureChannel(context, notice.channel, notice.channelName)
    val builder = NotificationCompat.Builder(context, notice.channel)
      .setSmallIcon(R.drawable.cialai_notification_terminal)
      .setContentTitle(notice.title)
      .setContentText(notice.body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(notice.body))
      .setAutoCancel(true)
      .setPriority(if (notice.channel == "attention") NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
    notice.subtitle?.let { builder.setSubText(it) }
    notice.color?.let { builder.setColor(it) }
    notice.image?.let { builder.setLargeIcon(it) }
    if (silent) builder.setSilent(true)
    openIntent(context, notice)?.let { builder.setContentIntent(it) }
    return try {
      manager.notify(notice.tag, NOTICE_ID, builder.build())
      true
    } catch (_: SecurityException) {
      // Permissão retirada entre a conferência e o envio.
      false
    }
  }

  private fun openIntent(context: Context, notice: Notice): PendingIntent? {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    if (notice.desktopId != null && notice.sessionId != null) {
      launch.putExtra(EXTRA_DESKTOP, notice.desktopId)
      launch.putExtra(EXTRA_SESSION, notice.sessionId)
    }
    // Um pedido por aviso, para cada toque levar a própria sessão.
    return PendingIntent.getActivity(context, notice.tag.hashCode(), launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  // Os canais são os do expo-notifications, com os mesmos ids; aqui só são
  // criados se o aviso chegar antes deles.
  private fun ensureChannel(context: Context, id: String, name: String) {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(id) != null) return
    val importance = if (id == "attention") NotificationManager.IMPORTANCE_HIGH else NotificationManager.IMPORTANCE_DEFAULT
    manager.createNotificationChannel(NotificationChannel(id, name, importance))
  }

  // Sessão do toque, tirada do Intent para não ser entregue duas vezes.
  fun takeTarget(intent: Intent?): Map<String, String>? {
    val desktopId = intent?.getStringExtra(EXTRA_DESKTOP) ?: return null
    val sessionId = intent.getStringExtra(EXTRA_SESSION) ?: return null
    intent.removeExtra(EXTRA_DESKTOP)
    intent.removeExtra(EXTRA_SESSION)
    return mapOf("desktopId" to desktopId, "sessionId" to sessionId)
  }
}
