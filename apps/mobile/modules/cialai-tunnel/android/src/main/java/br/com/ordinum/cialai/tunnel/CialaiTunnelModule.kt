// SPDX-License-Identifier: Apache-2.0
package br.com.ordinum.cialai.tunnel

import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import mobile.Listener
import mobile.Mobile
import mobile.Tunnel
import org.json.JSONArray
import org.json.JSONObject

// Ponte do núcleo Go v2 para o TypeScript. As chamadas saem da thread principal
// por três filas seriais: pareamento, operações que trocam caminho ou proxy, e
// consultas curtas. Assim uma conexão que espera a reserva não prende o status,
// a descoberta local nem o Stop, que cancela o que está em andamento no Go.
// O módulo também cuida do tor em processo, da descoberta DNS-SD e da parada
// após 120 s em segundo plano, com reabertura do último computador na volta.
class CialaiTunnelModule : Module(), Listener, TorRuntime.Events {
  private val pairing = lane("cialai-tunnel-pair")
  private val operations = lane("cialai-tunnel-ops")
  private val queries = lane("cialai-tunnel-query")
  private val mainHandler = Handler(Looper.getMainLooper())

  private val tunnelLock = Any()
  @Volatile private var tunnel: Tunnel? = null
  @Volatile private var destroyed = false
  @Volatile private var tor: TorRuntime? = null
  @Volatile private var discovery: LanDiscovery? = null
  @Volatile private var logLevel = LOG_INFO

  // Estado do ciclo de vida, protegido por lifecycle.
  private val lifecycle = Any()
  private var lastOpen: DesktopOpen? = null
  private var activeDesktopId: String? = null
  private var backgroundedAt: Long? = null
  private var stoppedForBackground = false
  // Tipo da rede na última notificação, para só reiniciar o DNS-SD quando ele muda de fato.
  private var lastNetworkKind: String? = null

  private val backgroundStop = Runnable { queries.post { stopForBackground(overdue = false) } }

  override fun definition() = ModuleDefinition {
    Name("CialaiTunnel")
    Events("onTunnelEvent")

    OnCreate {
      val context = appContext.reactContext?.applicationContext ?: return@OnCreate
      tor = TorRuntime(context, this@CialaiTunnelModule)
      discovery = LanDiscovery(context, ::reportLan, ::nativeLog)
      queries.post { requireTunnel() }
      tor?.start()
    }

    OnDestroy {
      destroyed = true
      mainHandler.removeCallbacks(backgroundStop)
      discovery?.close()
      tor?.close()
      queries.post {
        runCatching { tunnel?.stop() }
        tunnel = null
      }
      pairing.shutdown()
      operations.shutdown()
      queries.shutdown()
    }

    Function("version") { Mobile.version() }

    AsyncFunction("inspectPairPayload") { payload: String, promise: Promise ->
      execute(queries, promise) { jsonObject(requireTunnel().inspectPairPayload(payload)) }
    }

    AsyncFunction("pair") { payload: String, device: Map<String, String>, promise: Promise ->
      execute(pairing, promise) {
        val name = device["name"] ?: throw IllegalArgumentException("device_invalid: Informe o nome do aparelho.")
        val model = device["model"] ?: throw IllegalArgumentException("device_invalid: Informe o modelo do aparelho.")
        val platform = device["platform"] ?: throw IllegalArgumentException("device_invalid: Informe a plataforma do aparelho.")
        val app = device["app"] ?: throw IllegalArgumentException("device_invalid: Informe a versão do aplicativo.")
        jsonObject(requireTunnel().pair(payload, name, model, platform, app))
      }
    }

    AsyncFunction("connect") { desktopId: String, promise: Promise ->
      execute(operations, promise) {
        val current = requireTunnel()
        synchronized(lifecycle) { activeDesktopId = desktopId }
        searchLan(current, desktopId, forget = false)
        // Um tor recém iniciado entrega os ouvintes em poucos segundos; sem essa
        // espera o Go veria a reserva como indisponível em vez de preparando.
        tor?.awaitEndpoints(TOR_HANDOVER_WAIT_MS)
        jsonObject(current.connect(desktopId))
      }
    }

    AsyncFunction("openDesktop") { desktopId: String, deviceToken: String, preferredPort: Int, promise: Promise ->
      execute(operations, promise) {
        val result = jsonObject(requireTunnel().openDesktop(desktopId, deviceToken, preferredPort.toLong()))
        val port = (result["port"] as? Number)?.toInt() ?: preferredPort
        synchronized(lifecycle) {
          lastOpen = DesktopOpen(desktopId, deviceToken, port)
          activeDesktopId = desktopId
        }
        result
      }
    }

    AsyncFunction("closeDesktop") { desktopId: String, promise: Promise ->
      execute(operations, promise) {
        requireTunnel().closeDesktop(desktopId)
        forgetActive(desktopId)
        null
      }
    }

    AsyncFunction("stop") { promise: Promise ->
      execute(queries, promise) {
        requireTunnel().stop()
        synchronized(lifecycle) {
          lastOpen = null
          activeDesktopId = null
          stoppedForBackground = false
        }
        discovery?.stop()
        null
      }
    }

    AsyncFunction("status") { promise: Promise ->
      execute(queries, promise) {
        val status = jsonObject(requireTunnel().statusJSON()).toMutableMap()
        // O tor é do nativo: o progresso dele vale mais que a última visão do Go.
        tor?.snapshot()?.let { status["tor"] = mapOf("state" to it.state, "progress" to it.progress) }
        status
      }
    }

    AsyncFunction("desktops") { promise: Promise ->
      execute(queries, promise) { jsonObject(requireTunnel().desktopsJSON()) }
    }

    // O JS já segura oscilações do NetInfo; aqui a busca local só recomeça, descartando
    // o que já foi achado, quando o tipo de rede mudou de fato, como Wi-Fi para rede
    // móvel. Uma notificação com a mesma rede não derruba a descoberta em andamento.
    Function("notifyNetworkChange") { reachable: Boolean ->
      queries.post {
        requireTunnel().notifyNetworkChange(reachable)
        val kind = if (reachable) currentNetworkKind() else NETWORK_NONE
        val (desktopId, changed) = synchronized(lifecycle) {
          val changed = lastNetworkKind != kind
          lastNetworkKind = kind
          activeDesktopId.takeIf { backgroundedAt == null && !stoppedForBackground } to changed
        }
        when {
          !reachable -> discovery?.stop()
          desktopId != null && changed -> searchLan(requireTunnel(), desktopId, forget = true)
        }
      }
    }

    Function("notifyForeground") { active: Boolean ->
      if (active) enterForeground() else enterBackground()
    }

    // No Android o ciclo de vida não marca reinício do zero; a confirmação de saúde do
    // App não tem o que limpar aqui.
    Function("notifyHealthy") { }

    AsyncFunction("forgetDesktop") { desktopId: String, promise: Promise ->
      execute(operations, promise) {
        requireTunnel().forgetDesktop(desktopId)
        forgetActive(desktopId)
        null
      }
    }

    Function("setLogLevel") { level: String ->
      val index = LOG_LEVELS.indexOf(level)
      if (index >= 0) logLevel = index
      queries.post { requireTunnel().setLogLevel(level) }
    }
  }

  // Eventos do núcleo Go.
  override fun onEvent(kind: String?, payloadJSON: String?) {
    if (kind == null || payloadJSON == null) return
    val payload = runCatching { jsonObject(payloadJSON) }.getOrNull() ?: return
    if (kind == "proxy") trackProxy(payload)
    emit(kind, payload)
  }

  override fun onTorEndpoints(socks: String, control: String, cookiePath: String) {
    queries.post {
      try {
        requireTunnel().setTorEndpoints(socks, control, cookiePath)
      } catch (error: Throwable) {
        nativeLog("error", "tor listeners refused by the core: ${stableCode(error)}")
      }
    }
  }

  override fun onTorState(state: String, progress: Int) {
    emit("tor", mapOf("state" to state, "progress" to progress))
  }

  override fun onTorLog(level: String, message: String) = nativeLog(level, message)

  private fun enterBackground() {
    val first = synchronized(lifecycle) {
      val first = backgroundedAt == null
      if (first) backgroundedAt = SystemClock.elapsedRealtime()
      first
    }
    if (!first) return
    mainHandler.removeCallbacks(backgroundStop)
    mainHandler.postDelayed(backgroundStop, BACKGROUND_TTL_MS)
    discovery?.stop()
    queries.post { requireTunnel().notifyForeground(false) }
  }

  private fun enterForeground() {
    mainHandler.removeCallbacks(backgroundStop)
    val since = synchronized(lifecycle) {
      val since = backgroundedAt
      backgroundedAt = null
      since
    }
    queries.post {
      // Com o processo congelado o temporizador pode não ter disparado a tempo;
      // passado o prazo, as conexões são tratadas como mortas do mesmo jeito.
      if (since != null && SystemClock.elapsedRealtime() - since >= BACKGROUND_TTL_MS) {
        stopForBackground(overdue = true)
      }
      tor?.start()
      val (wasStopped, reopen) = synchronized(lifecycle) {
        val stopped = stoppedForBackground
        stoppedForBackground = false
        stopped to lastOpen?.takeIf { stopped }
      }
      if (!wasStopped) {
        requireTunnel().notifyForeground(true)
        val desktopId = synchronized(lifecycle) { activeDesktopId }
        if (desktopId != null) searchLan(requireTunnel(), desktopId, forget = false)
      } else if (reopen != null) {
        operations.post { reopen(reopen) }
      }
    }
  }

  // Roda na fila de consultas. overdue vale quando a volta ao primeiro plano
  // encontrou o prazo vencido sem a parada ter acontecido.
  private fun stopForBackground(overdue: Boolean) {
    synchronized(lifecycle) {
      if (stoppedForBackground) return
      if (!overdue && backgroundedAt == null) return
      stoppedForBackground = true
    }
    discovery?.stop()
    runCatching { requireTunnel().stop() }
    tor?.stop()
    nativeLog("info", "core and tor stopped after the background deadline")
    emit("state", mapOf("state" to "background-stopped"))
  }

  // Roda na fila de operações: Connect e OpenDesktop do último computador aberto,
  // com os eventos que o App espera.
  private fun reopen(requested: DesktopOpen) {
    val open = synchronized(lifecycle) { lastOpen?.takeIf { it.desktopId == requested.desktopId } } ?: return
    emit("state", mapOf("state" to "reconnecting", "desktopId" to open.desktopId))
    val started = SystemClock.elapsedRealtime()
    try {
      val current = requireTunnel()
      searchLan(current, open.desktopId, forget = true)
      tor?.awaitEndpoints(TOR_HANDOVER_WAIT_MS)
      val connected = jsonObject(current.connect(open.desktopId))
      // O token pode ter girado enquanto a conexão era refeita.
      val token = synchronized(lifecycle) { lastOpen?.takeIf { it.desktopId == open.desktopId }?.deviceToken }
        ?: throw IllegalStateException("desktop_not_open: O computador foi fechado durante a reconexão.")
      val opened = jsonObject(current.openDesktop(open.desktopId, token, open.port.toLong()))
      val port = (opened["port"] as? Number)?.toInt() ?: open.port
      synchronized(lifecycle) {
        if (lastOpen?.desktopId == open.desktopId) lastOpen = DesktopOpen(open.desktopId, token, port)
      }
      nativeLog("info", "reopened ${open.desktopId} over ${connected["path"]} in ${SystemClock.elapsedRealtime() - started} ms")
      emit("proxy", opened + mapOf(
        "state" to "reopened",
        "desktopId" to open.desktopId,
        "transport" to connected["transport"],
        "path" to connected["path"]
      ))
    } catch (error: Throwable) {
      nativeLog("info", "reopening ${open.desktopId} failed: ${stableCode(error)}")
      emit("state", mapOf("state" to "reconnect-failed", "desktopId" to open.desktopId, "code" to stableCode(error)))
    }
  }

  private fun trackProxy(payload: Map<String, Any?>) {
    val desktopId = payload["desktopId"] as? String ?: return
    when (payload["state"]) {
      "token-rotated" -> {
        val token = payload["deviceToken"] as? String ?: return
        synchronized(lifecycle) {
          lastOpen?.takeIf { it.desktopId == desktopId }?.let { lastOpen = it.copy(deviceToken = token) }
        }
      }
      "revoked" -> forgetActive(desktopId)
    }
  }

  private fun forgetActive(desktopId: String) {
    val wasActive = synchronized(lifecycle) {
      if (lastOpen?.desktopId == desktopId) lastOpen = null
      val active = activeDesktopId == desktopId
      if (active) activeDesktopId = null
      active
    }
    if (wasActive) discovery?.stop()
  }

  // Transporte da rede ativa segundo o sistema; desconhecido quando não há rede ativa.
  private fun currentNetworkKind(): String {
    val context = appContext.reactContext?.applicationContext ?: return NETWORK_UNKNOWN
    val manager = context.getSystemService(ConnectivityManager::class.java) ?: return NETWORK_UNKNOWN
    val capabilities = runCatching { manager.getNetworkCapabilities(manager.activeNetwork) }.getOrNull()
      ?: return NETWORK_UNKNOWN
    return when {
      capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
      capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
      capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
      else -> NETWORK_UNKNOWN
    }
  }

  private fun searchLan(current: Tunnel, desktopId: String, forget: Boolean) {
    val lan = discovery ?: return
    // Uma reconexão pedida em segundo plano não prende o MulticastLock com o
    // processo que o sistema pode congelar a qualquer momento.
    if (synchronized(lifecycle) { backgroundedAt != null }) return
    val fingerprint = runCatching { fingerprintOf(current.desktopsJSON(), desktopId) }.getOrNull() ?: return
    lan.search(desktopId, fingerprint, forget)
  }

  private fun reportLan(desktopId: String, reportJSON: String) {
    queries.post {
      try {
        requireTunnel().reportLanCandidates(desktopId, reportJSON)
      } catch (error: Throwable) {
        nativeLog("error", "local discovery report refused: ${stableCode(error)}")
      }
    }
  }

  private fun requireTunnel(): Tunnel {
    tunnel?.let { return it }
    synchronized(tunnelLock) {
      tunnel?.let { return it }
      val context = appContext.reactContext
      if (destroyed || context == null) {
        throw IllegalStateException("tunnel_unavailable: O núcleo do túnel ainda não está pronto.")
      }
      val directory = File(context.noBackupFilesDir, "cialai/tunnel")
      if (!directory.exists() && !directory.mkdirs()) {
        throw IllegalStateException("state_invalid: Não foi possível preparar o diretório do túnel.")
      }
      return Mobile.newTunnel(directory.absolutePath, this).also { tunnel = it }
    }
  }

  private fun execute(lane: ExecutorService, promise: Promise, operation: () -> Any?) {
    try {
      lane.execute {
        try {
          promise.resolve(operation())
        } catch (error: Throwable) {
          promise.reject(stableCode(error), error.message ?: "O núcleo do túnel falhou.", error)
        }
      }
    } catch (error: RejectedExecutionException) {
      promise.reject("tunnel_unavailable", "O núcleo do túnel foi encerrado.", error)
    }
  }

  private fun ExecutorService.post(block: () -> Unit) {
    try {
      execute {
        try {
          block()
        } catch (error: Throwable) {
          nativeLog("error", "tunnel task failed: ${stableCode(error)}")
        }
      }
    } catch (error: RejectedExecutionException) {
      // Módulo encerrado.
    }
  }

  private fun emit(kind: String, payload: Map<String, Any?>) {
    runCatching { sendEvent("onTunnelEvent", mapOf("kind" to kind, "payload" to payload)) }
  }

  // Mensagens nativas sem token, payload ou endereço do computador.
  private fun nativeLog(level: String, message: String) {
    val index = LOG_LEVELS.indexOf(level).coerceAtLeast(0)
    when (index) {
      LOG_ERROR -> Log.w(LOG_TAG, message)
      LOG_INFO -> Log.i(LOG_TAG, message)
      else -> Log.d(LOG_TAG, message)
    }
    if (index <= logLevel) emit("log", mapOf("level" to LOG_LEVELS[index], "message" to message))
  }

  private fun stableCode(error: Throwable): String {
    val message = error.message ?: return "tunnel_failed"
    return message.substringBefore(':').takeIf { it.matches(CODE_PATTERN) } ?: "tunnel_failed"
  }

  private fun fingerprintOf(desktopsJSON: String, desktopId: String): String? {
    val desktops = JSONObject(desktopsJSON).optJSONArray("desktops") ?: return null
    for (index in 0 until desktops.length()) {
      val desktop = desktops.optJSONObject(index) ?: continue
      if (desktop.optString("id") == desktopId) return desktop.optString("fingerprint").takeIf { it.isNotEmpty() }
    }
    return null
  }

  @Suppress("UNCHECKED_CAST")
  private fun jsonObject(raw: String): Map<String, Any?> = jsonValue(JSONObject(raw)) as Map<String, Any?>

  private fun jsonValue(value: Any?): Any? = when (value) {
    JSONObject.NULL, null -> null
    is JSONObject -> value.keys().asSequence().associateWith { key -> jsonValue(value.get(key)) }
    is JSONArray -> (0 until value.length()).map { index -> jsonValue(value.get(index)) }
    else -> value
  }

  private companion object {
    const val BACKGROUND_TTL_MS = 120_000L
    const val TOR_HANDOVER_WAIT_MS = 15_000L
    const val LOG_TAG = "CialaiTunnel"
    const val NETWORK_NONE = "none"
    const val NETWORK_UNKNOWN = "unknown"
    const val LOG_ERROR = 0
    const val LOG_INFO = 1
    val LOG_LEVELS = listOf("error", "info", "debug")
    val CODE_PATTERN = Regex("[a-z_]+")

    fun lane(name: String): ExecutorService = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, name) }
  }
}

private data class DesktopOpen(
  val desktopId: String,
  val deviceToken: String,
  val port: Int
) {
  // O token não aparece em logs nem em relatórios de falha.
  override fun toString(): String = "DesktopOpen(desktopId=$desktopId, port=$port)"
}
