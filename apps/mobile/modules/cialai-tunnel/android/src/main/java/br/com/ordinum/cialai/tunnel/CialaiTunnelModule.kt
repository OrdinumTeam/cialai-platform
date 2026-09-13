// SPDX-License-Identifier: Apache-2.0
package br.com.ordinum.cialai.tunnel

import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import mobile.Listener
import mobile.Mobile
import mobile.Tunnel
import org.json.JSONArray
import org.json.JSONObject

class CialaiTunnelModule : Module(), Listener {
  private val executor: ExecutorService = Executors.newSingleThreadExecutor()
  private val lifecycleHandler = Handler(Looper.getMainLooper())
  @Volatile private var tunnel: Tunnel? = null
  private var activeProfileId: String? = null
  private var lastOpen: DesktopOpen? = null
  private var stoppedForBackground = false
  private val backgroundStop = Runnable {
    executor.execute {
      runCatching { tunnel?.stop() }
      stoppedForBackground = true
      sendEvent("onTunnelEvent", mapOf(
        "kind" to "state",
        "payload" to mapOf("state" to "background-stopped")
      ))
    }
  }

  override fun definition() = ModuleDefinition {
    Name("CialaiTunnel")
    Events("onTunnelEvent")

    OnCreate {
      executor.execute {
        val context = appContext.reactContext ?: return@execute
        val directory = File(context.noBackupFilesDir, "cialai/tunnel")
        if (!directory.exists() && !directory.mkdirs()) return@execute
        tunnel = Mobile.newTunnel(directory.absolutePath, this@CialaiTunnelModule)
      }
    }

    OnDestroy {
      lifecycleHandler.removeCallbacks(backgroundStop)
      executor.execute {
        runCatching { tunnel?.stop() }
        tunnel = null
        activeProfileId = null
        lastOpen = null
      }
      executor.shutdown()
    }

    Function("version") { Mobile.version() }

    AsyncFunction("inspectPairPayload") { payload: String, promise: Promise ->
      execute(promise) { jsonObject(requireTunnel().inspectPairPayload(payload)) }
    }

    AsyncFunction("pair") { payload: String, device: Map<String, String>, promise: Promise ->
      execute(promise) {
        val name = device["name"] ?: throw IllegalArgumentException("device_invalid: Informe o nome do aparelho.")
        val model = device["model"] ?: throw IllegalArgumentException("device_invalid: Informe o modelo do aparelho.")
        val platform = device["platform"] ?: throw IllegalArgumentException("device_invalid: Informe a plataforma do aparelho.")
        val app = device["app"] ?: throw IllegalArgumentException("device_invalid: Informe a versão do aplicativo.")
        val result = jsonObject(requireTunnel().pair(payload, name, model, platform, app))
        activeProfileId = result["profileId"] as? String
        result
      }
    }

    AsyncFunction("startProfile") { profileId: String, promise: Promise ->
      execute(promise) {
        requireTunnel().startProfile(profileId)
        activeProfileId = profileId
        stoppedForBackground = false
      }
    }

    AsyncFunction("stop") { promise: Promise ->
      execute(promise) {
        requireTunnel().stop()
        activeProfileId = null
        lastOpen = null
        stoppedForBackground = false
      }
    }

    AsyncFunction("status") { promise: Promise ->
      execute(promise) { jsonObject(requireTunnel().statusJSON()) }
    }

    AsyncFunction("openDesktop") { desktopId: String, deviceToken: String, preferredPort: Int, promise: Promise ->
      execute(promise) {
        val result = jsonObject(requireTunnel().openDesktop(desktopId, deviceToken, preferredPort.toLong()))
        lastOpen = DesktopOpen(desktopId, deviceToken, preferredPort)
        result
      }
    }

    AsyncFunction("closeDesktop") { desktopId: String, promise: Promise ->
      execute(promise) {
        requireTunnel().closeDesktop(desktopId)
        if (lastOpen?.desktopId == desktopId) lastOpen = null
      }
    }

    Function("notifyNetworkChange") { reachable: Boolean ->
      executor.execute { tunnel?.notifyNetworkChange(reachable) }
    }

    Function("notifyForeground") { active: Boolean ->
      lifecycleHandler.removeCallbacks(backgroundStop)
      if (!active) {
        executor.execute { tunnel?.notifyForeground(false) }
        lifecycleHandler.postDelayed(backgroundStop, BACKGROUND_TTL_MS)
      } else {
        executor.execute { restoreForeground() }
      }
    }

    AsyncFunction("forgetProfile") { profileId: String, promise: Promise ->
      execute(promise) {
        requireTunnel().forgetProfile(profileId)
        if (activeProfileId == profileId) {
          activeProfileId = null
          lastOpen = null
          stoppedForBackground = false
        }
      }
    }

    Function("setLogLevel") { level: String ->
      executor.execute { tunnel?.setLogLevel(level) }
    }
  }

  override fun onEvent(kind: String?, payloadJSON: String?) {
    if (kind == null || payloadJSON == null) return
    runCatching {
      sendEvent("onTunnelEvent", mapOf("kind" to kind, "payload" to jsonObject(payloadJSON)))
    }
  }

  private fun restoreForeground() {
    val current = tunnel ?: return
    if (!stoppedForBackground) {
      current.notifyForeground(true)
      return
    }
    val profileId = activeProfileId
    val open = lastOpen
    if (profileId == null || open == null) {
      stoppedForBackground = false
      return
    }
    sendEvent("onTunnelEvent", mapOf(
      "kind" to "state",
      "payload" to mapOf("state" to "reconnecting", "desktopId" to open.desktopId)
    ))
    try {
      current.startProfile(profileId)
      val opened = jsonObject(current.openDesktop(open.desktopId, open.deviceToken, open.preferredPort.toLong()))
      stoppedForBackground = false
      sendEvent("onTunnelEvent", mapOf(
        "kind" to "proxy",
        "payload" to opened + mapOf("state" to "reopened", "desktopId" to open.desktopId)
      ))
    } catch (error: Throwable) {
      sendEvent("onTunnelEvent", mapOf(
        "kind" to "state",
        "payload" to mapOf("state" to "reconnect-failed", "code" to stableCode(error))
      ))
    }
  }

  private fun requireTunnel(): Tunnel =
    tunnel ?: throw IllegalStateException("tunnel_unavailable: O núcleo do túnel ainda não está pronto.")

  private fun execute(promise: Promise, operation: () -> Any?) {
    executor.execute {
      try {
        promise.resolve(operation())
      } catch (error: Throwable) {
        val message = error.message ?: "O núcleo do túnel falhou."
        promise.reject(stableCode(error), message, error)
      }
    }
  }

  private fun stableCode(error: Throwable): String {
    val message = error.message ?: return "tunnel_failed"
    return message.substringBefore(':').takeIf { it.matches(Regex("[a-z_]+")) } ?: "tunnel_failed"
  }

  @Suppress("UNCHECKED_CAST")
  private fun jsonObject(raw: String): Map<String, Any?> = jsonValue(JSONObject(raw)) as Map<String, Any?>

  private fun jsonValue(value: Any?): Any? = when (value) {
    JSONObject.NULL, null -> null
    is JSONObject -> value.keys().asSequence().associateWith { key -> jsonValue(value.get(key)) }
    is JSONArray -> (0 until value.length()).map { index -> jsonValue(value.get(index)) }
    else -> value
  }
}

private data class DesktopOpen(
  val desktopId: String,
  val deviceToken: String,
  val preferredPort: Int
)

private const val BACKGROUND_TTL_MS = 120_000L
