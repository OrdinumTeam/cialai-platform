// SPDX-License-Identifier: Apache-2.0
package br.com.ordinum.cialai.tunnel

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

// Serviço em primeiro plano que segura o processo, e com ele a conexão direta
// com o computador, enquanto o app está em segundo plano. Assim os retratos da
// página continuam chegando e os avisos das sessões saem com o app fora da
// tela. O aviso fixo diz a que computador o celular está ligado e traz
// Desconectar. Tirar o app dos recentes encerra o serviço junto, pelo
// stopWithTask do manifesto.
//
// O serviço não conhece o núcleo: avisa o módulo pelo `Listener` quando a
// pessoa pede para desconectar, quando o sistema recusa o primeiro plano e
// quando ele termina.
class ConnectionService : Service() {
  interface Listener {
    fun onDisconnectRequested()
    fun onKeepAliveRefused()
    fun onKeepAliveEnded()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_DISCONNECT) {
      listener?.onDisconnectRequested()
      return START_NOT_STICKY
    }
    val text = KeepAliveText.from(intent)
    try {
      ensureChannel(this, text.channel)
      val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE else 0
      ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(text), type)
    } catch (error: Exception) {
      // Android que recusa o primeiro plano: o módulo volta ao prazo de sempre.
      Log.w(LOG_TAG, "keep-alive refused: ${error.javaClass.simpleName}")
      listener?.onKeepAliveRefused()
      stopSelf()
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    listener?.onKeepAliveEnded()
    super.onDestroy()
  }

  private fun notification(text: KeepAliveText) = NotificationCompat.Builder(this, CHANNEL_ID)
    .setSmallIcon(R.drawable.cialai_notification_terminal)
    .setColor(BRAND_COLOR)
    .setContentTitle(text.title)
    .setContentText(text.body)
    .setStyle(NotificationCompat.BigTextStyle().bigText(text.body))
    .setOngoing(true)
    .setShowWhen(false)
    .setSilent(true)
    .setCategory(NotificationCompat.CATEGORY_SERVICE)
    .setPriority(NotificationCompat.PRIORITY_LOW)
    .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
    .setContentIntent(openAppIntent(this))
    .addAction(0, text.action, PendingIntent.getService(
      this,
      REQUEST_DISCONNECT,
      Intent(this, ConnectionService::class.java).setAction(ACTION_DISCONNECT),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    ))
    .build()

  // Textos do aviso fixo no idioma do app; o módulo recebe do TypeScript.
  data class KeepAliveText(val title: String, val body: String, val action: String, val channel: String) {
    fun into(intent: Intent): Intent = intent
      .putExtra(EXTRA_TITLE, title)
      .putExtra(EXTRA_BODY, body)
      .putExtra(EXTRA_ACTION, action)
      .putExtra(EXTRA_CHANNEL, channel)

    companion object {
      val DEFAULT = KeepAliveText(
        title = "Cialai connected",
        body = "Session alerts keep arriving while the app is in the background.",
        action = "Disconnect",
        channel = "Computer connection"
      )

      fun from(intent: Intent?): KeepAliveText = KeepAliveText(
        title = intent?.getStringExtra(EXTRA_TITLE) ?: DEFAULT.title,
        body = intent?.getStringExtra(EXTRA_BODY) ?: DEFAULT.body,
        action = intent?.getStringExtra(EXTRA_ACTION) ?: DEFAULT.action,
        channel = intent?.getStringExtra(EXTRA_CHANNEL) ?: DEFAULT.channel
      )
    }
  }

  companion object {
    @Volatile var listener: Listener? = null

    const val CHANNEL_ID = "cialai-connection"
    const val NOTIFICATION_ID = 0x4C17
    private const val REQUEST_DISCONNECT = 0x4C18
    private const val ACTION_DISCONNECT = "br.com.ordinum.cialai.tunnel.DISCONNECT"
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_BODY = "body"
    private const val EXTRA_ACTION = "action"
    private const val EXTRA_CHANNEL = "channel"
    private const val LOG_TAG = "CialaiTunnel"
    // Rosa do Cialai: o aviso fixo é do app, não de uma sessão.
    private val BRAND_COLOR = Color.parseColor("#E23B84")

    fun start(context: Context, text: KeepAliveText) {
      val intent = text.into(Intent(context, ConnectionService::class.java))
      context.startForegroundService(intent)
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, ConnectionService::class.java))
    }

    // Canal discreto, sem som: o aviso fixo só informa.
    private fun ensureChannel(context: Context, name: String) {
      val manager = context.getSystemService(NotificationManager::class.java) ?: return
      val channel = manager.getNotificationChannel(CHANNEL_ID)
      if (channel == null) {
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, name, NotificationManager.IMPORTANCE_LOW).apply {
          setShowBadge(false)
        })
      } else if (channel.name != name) {
        channel.name = name
        manager.createNotificationChannel(channel)
      }
    }

    // Toque no aviso: traz o app de volta como estava.
    fun openAppIntent(context: Context): PendingIntent? {
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
      launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      return PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
  }
}
