// SPDX-License-Identifier: Apache-2.0
package br.com.ordinum.cialai.tunnel

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import androidx.annotation.RequiresApi
import java.net.Inet4Address
import java.net.InetAddress
import java.util.ArrayDeque
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject

// Descobre por DNS-SD o computador esperado na rede local e repassa ao núcleo os
// endereços resolvidos, que o Go valida de novo em mdns.ParseReported. Cada busca
// dura uma janela curta, com o MulticastLock preso só enquanto ela corre; parar a
// busca solta o ouvinte, os callbacks de resolução e a trava.
internal class LanDiscovery(
  context: Context,
  private val report: (desktopId: String, reportJSON: String) -> Unit,
  private val log: (level: String, message: String) -> Unit
) {
  private val nsd: NsdManager? = context.applicationContext.getSystemService(NsdManager::class.java)
  private val wifi: WifiManager? = context.applicationContext.getSystemService(WifiManager::class.java)
  private val worker: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { runnable ->
    Thread(runnable, "cialai-lan").apply { isDaemon = true }
  }

  // Campos abaixo só são tocados pela thread do worker.
  private var generation = 0
  private var browse: Browse? = null
  private var target: LanTarget? = null
  private var lastReport: String? = null
  private val resolved = linkedMapOf<String, LanService>()

  // Procura o computador por uma janela. forget descarta o que foi achado antes,
  // como numa troca de rede, e informa a lista vazia ao núcleo.
  fun search(desktopId: String, fingerprint: String, forget: Boolean) {
    worker.execute {
      val next = LanTarget(desktopId, fingerprint)
      if (target != next) lastReport = null
      target = next
      if (forget) {
        resolved.clear()
        endBrowse()
        publish(force = true)
      }
      val current = browse
      if (current != null) {
        current.window?.cancel(false)
        current.window = scheduleWindowEnd(current.generation)
        return@execute
      }
      startBrowse()
    }
  }

  fun stop() {
    worker.execute { endBrowse() }
  }

  fun close() {
    worker.execute {
      endBrowse()
      target = null
      resolved.clear()
    }
    worker.shutdown()
  }

  private fun startBrowse() {
    val manager = nsd ?: return
    val run = ++generation
    val lock = wifi?.createMulticastLock(LOCK_TAG)?.apply { setReferenceCounted(false) }
    runCatching { lock?.acquire() }.onFailure { log("error", "multicast lock unavailable") }
    val listener = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(serviceType: String?) = Unit
      override fun onDiscoveryStopped(serviceType: String?) = Unit
      override fun onStopDiscoveryFailed(serviceType: String?, errorCode: Int) = Unit
      override fun onStartDiscoveryFailed(serviceType: String?, errorCode: Int) {
        worker.execute {
          if (run != generation) return@execute
          log("error", "local discovery failed to start: $errorCode")
          browse?.registered = false
          endBrowse()
        }
      }
      override fun onServiceFound(serviceInfo: NsdServiceInfo?) {
        val info = serviceInfo ?: return
        worker.execute { if (run == generation) found(info) }
      }
      override fun onServiceLost(serviceInfo: NsdServiceInfo?) {
        val name = serviceInfo?.serviceName ?: return
        worker.execute { if (run == generation) lost(name) }
      }
    }
    val current = Browse(run, listener, lock)
    browse = current
    try {
      manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
      current.registered = true
    } catch (error: RuntimeException) {
      log("error", "local discovery refused: ${error.javaClass.simpleName}")
      endBrowse()
      return
    }
    current.window = scheduleWindowEnd(run)
    log("debug", "local discovery started")
  }

  private fun scheduleWindowEnd(run: Int): ScheduledFuture<*> =
    worker.schedule({ if (run == generation) endBrowse() }, WINDOW_MS, TimeUnit.MILLISECONDS)

  private fun endBrowse() {
    val current = browse ?: return
    browse = null
    generation++
    current.window?.cancel(false)
    val manager = nsd
    if (manager != null) {
      if (current.registered) runCatching { manager.stopServiceDiscovery(current.listener) }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        for (callback in current.callbacks.values) {
          runCatching { manager.unregisterServiceInfoCallback(callback as NsdManager.ServiceInfoCallback) }
        }
      }
    }
    current.callbacks.clear()
    current.pending.clear()
    current.lock?.let { lock -> runCatching { if (lock.isHeld) lock.release() } }
    log("debug", "local discovery stopped")
  }

  private fun found(info: NsdServiceInfo) {
    val current = browse ?: return
    val name = info.serviceName ?: return
    if (!name.startsWith(INSTANCE_PREFIX)) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      follow(current, name, info)
    } else {
      if (current.pending.none { it.serviceName == name }) current.pending.add(info)
      resolveNext(current)
    }
  }

  @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
  private fun follow(current: Browse, name: String, info: NsdServiceInfo) {
    val manager = nsd ?: return
    if (current.callbacks.containsKey(name)) return
    val run = current.generation
    val callback = object : NsdManager.ServiceInfoCallback {
      override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) {
        if (run == generation) browse?.callbacks?.remove(name)
      }
      override fun onServiceUpdated(serviceInfo: NsdServiceInfo) {
        if (run == generation) update(name, serviceInfo.hostAddresses, serviceInfo.port, serviceInfo.attributes)
      }
      override fun onServiceLost() {
        if (run == generation) lost(name)
      }
      override fun onServiceInfoCallbackUnregistered() = Unit
    }
    try {
      manager.registerServiceInfoCallback(info, worker, callback)
      current.callbacks[name] = callback
    } catch (error: RuntimeException) {
      log("error", "local discovery could not follow a service: ${error.javaClass.simpleName}")
    }
  }

  // Antes do Android 14 o NsdManager resolve um serviço por vez.
  @Suppress("DEPRECATION")
  private fun resolveNext(current: Browse) {
    val manager = nsd ?: return
    if (current.resolving) return
    val info = current.pending.poll() ?: return
    current.resolving = true
    val run = current.generation
    val listener = object : NsdManager.ResolveListener {
      override fun onResolveFailed(serviceInfo: NsdServiceInfo?, errorCode: Int) {
        worker.execute {
          if (run != generation) return@execute
          current.resolving = false
          resolveNext(current)
        }
      }
      override fun onServiceResolved(serviceInfo: NsdServiceInfo?) {
        worker.execute {
          if (run != generation) return@execute
          current.resolving = false
          val resolvedInfo = serviceInfo
          if (resolvedInfo != null) {
            update(info.serviceName, listOfNotNull(resolvedInfo.host), resolvedInfo.port, resolvedInfo.attributes)
          }
          resolveNext(current)
        }
      }
    }
    try {
      manager.resolveService(info, listener)
    } catch (error: RuntimeException) {
      current.resolving = false
    }
  }

  private fun update(name: String, addresses: List<InetAddress>, port: Int, attributes: Map<String, ByteArray?>?) {
    val text = attributes.orEmpty()
    val hosts = addresses
      .sortedBy { if (it is Inet4Address) 0 else 1 }
      .mapNotNull { it.hostAddress }
    resolved[name] = LanService(
      id = text["id"]?.toString(Charsets.UTF_8).orEmpty(),
      fingerprint = text["fp"]?.toString(Charsets.UTF_8).orEmpty(),
      port = port,
      hosts = hosts
    )
    publish(force = false)
  }

  private fun lost(name: String) {
    if (resolved.remove(name) != null) publish(force = false)
  }

  private fun publish(force: Boolean) {
    val expected = target ?: return
    val entries = LanReport.entries(expected, resolved.values)
    if (entries.isEmpty() && !force && lastReport == null) return
    val json = LanReport.json(entries)
    if (json == lastReport) return
    lastReport = json
    report(expected.desktopId, json)
  }

  private class Browse(
    val generation: Int,
    val listener: NsdManager.DiscoveryListener,
    val lock: WifiManager.MulticastLock?
  ) {
    var registered = false
    var window: ScheduledFuture<*>? = null
    var resolving = false
    val pending = ArrayDeque<NsdServiceInfo>()
    // Callbacks do Android 14 guardados sem o tipo, que só existe nessa versão.
    val callbacks = mutableMapOf<String, Any>()
  }

  companion object {
    const val SERVICE_TYPE = "_cialai._udp"
    private const val INSTANCE_PREFIX = "cialai-"
    private const val LOCK_TAG = "cialai-lan"
    private const val WINDOW_MS = 30_000L
  }
}

internal data class LanTarget(val desktopId: String, val fingerprint: String)

internal data class LanService(val id: String, val fingerprint: String, val port: Int, val hosts: List<String>)

// Montagem do relatório aceito por mdns.ParseReported, sem estado, para os testes da JVM.
internal object LanReport {
  const val MAX_ENTRIES = 8

  data class Entry(val host: String, val port: Int, val id: String, val fp: String)

  // Só serviços cujo TXT traz o id e a impressão digital do computador esperado.
  fun entries(target: LanTarget, services: Collection<LanService>): List<Entry> =
    services
      .filter { it.id == target.desktopId && it.fingerprint == target.fingerprint && it.port in 1..65535 }
      .flatMap { service -> service.hosts.map { host -> Entry(host, service.port, service.id, service.fingerprint) } }
      .distinct()
      .take(MAX_ENTRIES)

  fun json(entries: List<Entry>): String {
    val array = JSONArray()
    for (entry in entries) {
      array.put(JSONObject().put("host", entry.host).put("port", entry.port).put("id", entry.id).put("fp", entry.fp))
    }
    return array.toString()
  }
}
