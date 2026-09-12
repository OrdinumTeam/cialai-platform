// SPDX-License-Identifier: Apache-2.0
package br.com.ordinum.cialai.tunnel

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
  @Volatile private var tunnel: Tunnel? = null

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
      executor.execute {
        runCatching { tunnel?.stop() }
        tunnel = null
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
        jsonObject(requireTunnel().pair(payload, name, model, platform, app))
      }
    }

    AsyncFunction("startProfile") { profileId: String, promise: Promise ->
      execute(promise) { requireTunnel().startProfile(profileId) }
    }

    AsyncFunction("stop") { promise: Promise ->
      execute(promise) { requireTunnel().stop() }
    }

    AsyncFunction("status") { promise: Promise ->
      execute(promise) { jsonObject(requireTunnel().statusJSON()) }
    }

    AsyncFunction("openDesktop") { desktopId: String, deviceToken: String, preferredPort: Int, promise: Promise ->
      execute(promise) {
        jsonObject(requireTunnel().openDesktop(desktopId, deviceToken, preferredPort.toLong()))
      }
    }

    AsyncFunction("closeDesktop") { desktopId: String, promise: Promise ->
      execute(promise) { requireTunnel().closeDesktop(desktopId) }
    }

    Function("notifyNetworkChange") { reachable: Boolean ->
      executor.execute { tunnel?.notifyNetworkChange(reachable) }
    }

    Function("notifyForeground") { active: Boolean ->
      executor.execute { tunnel?.notifyForeground(active) }
    }

    AsyncFunction("forgetProfile") { profileId: String, promise: Promise ->
      execute(promise) { requireTunnel().forgetProfile(profileId) }
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

  private fun requireTunnel(): Tunnel =
    tunnel ?: throw IllegalStateException("tunnel_unavailable: O núcleo do túnel ainda não está pronto.")

  private fun execute(promise: Promise, operation: () -> Any?) {
    executor.execute {
      try {
        promise.resolve(operation())
      } catch (error: Throwable) {
        val message = error.message ?: "O núcleo do túnel falhou."
        val code = message.substringBefore(':').takeIf { it.matches(Regex("[a-z_]+")) } ?: "tunnel_failed"
        promise.reject(code, message, error)
      }
    }
  }

  private fun jsonObject(raw: String): Map<String, Any?> = jsonValue(JSONObject(raw)) as Map<String, Any?>

  private fun jsonValue(value: Any?): Any? = when (value) {
    JSONObject.NULL, null -> null
    is JSONObject -> value.keys().asSequence().associateWith { key -> jsonValue(value.get(key)) }
    is JSONArray -> (0 until value.length()).map { index -> jsonValue(value.get(index)) }
    else -> value
  }
}
