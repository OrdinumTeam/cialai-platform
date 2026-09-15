// SPDX-License-Identifier: Apache-2.0
package br.com.ordinum.cialai.tunnel

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.IBinder
import android.os.SystemClock
import java.io.BufferedReader
import java.io.Closeable
import java.io.EOFException
import java.io.File
import java.io.IOException
import java.io.InputStreamReader
import java.io.OutputStream
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import org.torproject.jni.TorService

// Roda o tor do tor-android dentro do processo do app e entrega ao núcleo Go os
// ouvintes locais: SOCKS em 127.0.0.1 com porta automática e o ControlSocket
// Unix no diretório privado do TorService, que usa autenticação nula porque só o
// próprio app enxerga esse diretório. Os ouvintes vão ao Go assim que o controle
// responde, antes do fim do bootstrap, para o caminho de reserva distinguir
// "preparando" de "indisponível". Toda a lógica roda numa única thread própria.
internal class TorRuntime(context: Context, private val events: Events) {
  interface Events {
    // Strings vazias limpam os ouvintes quando o tor para.
    fun onTorEndpoints(socks: String, control: String, cookiePath: String)
    fun onTorState(state: String, progress: Int)
    fun onTorLog(level: String, message: String)
  }

  data class Snapshot(val state: String, val progress: Int)

  private val appContext = context.applicationContext
  private val worker: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { runnable ->
    Thread(runnable, "cialai-tor").apply { isDaemon = true }
  }

  // Campos abaixo só são tocados pela thread do worker.
  private var wanted = false
  private var generation = 0
  private var connection: ServiceConnection? = null
  private var control: TorControlSocket? = null
  private var poll: ScheduledFuture<*>? = null
  private var retry: ScheduledFuture<*>? = null
  private var launchedAt = 0L
  private var failures = 0

  private val signal = Object()
  @Volatile private var endpointsSet = false
  @Volatile private var snapshot = Snapshot(STATE_DISABLED, 0)

  fun snapshot(): Snapshot = snapshot

  fun start() {
    worker.execute {
      if (wanted) return@execute
      wanted = true
      failures = 0
      launch()
    }
  }

  fun stop() {
    worker.execute {
      wanted = false
      generation++
      retry?.cancel(false)
      retry = null
      teardown()
      publish(STATE_DISABLED, 0)
    }
  }

  fun close() {
    stop()
    worker.shutdown()
  }

  // Espera o tor entregar os ouvintes ao Go enquanto ele ainda está subindo.
  // Devolve se os ouvintes estão definidos; não espera um tor parado ou com falha.
  fun awaitEndpoints(timeoutMs: Long): Boolean {
    val deadline = SystemClock.elapsedRealtime() + timeoutMs
    synchronized(signal) {
      while (!endpointsSet && snapshot.state == STATE_STARTING) {
        val left = deadline - SystemClock.elapsedRealtime()
        if (left <= 0) break
        signal.wait(left)
      }
      return endpointsSet
    }
  }

  private fun launch() {
    retry?.cancel(false)
    retry = null
    val run = ++generation
    publish(STATE_STARTING, 0)
    // O tor-android não admite dois tor no mesmo processo: a thread do anterior
    // precisa terminar antes de o serviço novo chamar o main do tor.
    if (!awaitPreviousTorExit()) {
      fail(run, "tor_busy")
      return
    }
    try {
      writeTorrc()
    } catch (error: IOException) {
      fail(run, "tor_config_failed")
      return
    }
    val serviceConnection = object : ServiceConnection {
      override fun onServiceConnected(name: ComponentName?, service: IBinder?) = Unit
      override fun onServiceDisconnected(name: ComponentName?) = Unit
      override fun onBindingDied(name: ComponentName?) {
        worker.execute { fail(run, "tor_binding_died") }
      }
    }
    val bound = try {
      appContext.bindService(Intent(appContext, TorService::class.java), serviceConnection, Context.BIND_AUTO_CREATE)
    } catch (error: SecurityException) {
      false
    }
    if (!bound) {
      runCatching { appContext.unbindService(serviceConnection) }
      fail(run, "tor_bind_failed")
      return
    }
    connection = serviceConnection
    launchedAt = SystemClock.elapsedRealtime()
    events.onTorLog("info", "tor service bound")
    poll = worker.scheduleWithFixedDelay({ guardedStep(run) }, STARTUP_POLL_MS, STARTUP_POLL_MS, TimeUnit.MILLISECONDS)
  }

  // Uma exceção dentro de uma tarefa periódica cancelaria as próximas em silêncio.
  private fun guardedStep(run: Int) {
    try {
      step(run)
    } catch (error: RuntimeException) {
      fail(run, "tor_runtime_error")
    }
  }

  private fun step(run: Int) {
    if (run != generation || !wanted) return
    if (!endpointsSet) {
      handOver(run)
      return
    }
    val current = control ?: return fail(run, "tor_control_lost")
    val progress = (try {
      TorControlReplies.bootstrapProgress(current.getInfo(BOOTSTRAP_PHASE))
    } catch (error: IOException) {
      null
    }) ?: return fail(run, "tor_control_lost")
    if (progress >= 100) {
      if (snapshot.state != STATE_READY) {
        failures = 0
        events.onTorLog("info", "tor bootstrap done in ${SystemClock.elapsedRealtime() - launchedAt} ms")
        // Pronto, o controle só serve para notar a queda do tor.
        reschedule(run, READY_POLL_MS)
      }
      publish(STATE_READY, 100)
    } else {
      publish(STATE_BOOTSTRAPPING, progress)
    }
  }

  private fun handOver(run: Int) {
    val socketFile = controlSocketFile()
    val elapsed = SystemClock.elapsedRealtime() - launchedAt
    val socks = if (socketFile.exists()) {
      try {
        val opened = control ?: TorControlSocket.open(socketFile, CONTROL_TIMEOUT_MS).also {
          it.authenticate()
          control = it
        }
        TorControlReplies.socksListener(opened.getInfo(SOCKS_LISTENERS))
      } catch (error: IOException) {
        control?.let { runCatching { it.close() } }
        control = null
        null
      }
    } else {
      null
    }
    if (socks == null) {
      if (elapsed > HANDOVER_TIMEOUT_MS) fail(run, "tor_control_timeout")
      return
    }
    events.onTorEndpoints(socks, "unix:" + socketFile.absolutePath, "")
    synchronized(signal) {
      endpointsSet = true
      signal.notifyAll()
    }
    events.onTorLog("info", "tor listeners handed over in $elapsed ms")
    publish(STATE_BOOTSTRAPPING, 0)
    step(run)
  }

  private fun reschedule(run: Int, delayMs: Long) {
    poll?.cancel(false)
    poll = worker.scheduleWithFixedDelay({ guardedStep(run) }, delayMs, delayMs, TimeUnit.MILLISECONDS)
  }

  private fun fail(run: Int, code: String) {
    if (run != generation) return
    teardown()
    publish(STATE_FAILED, 0)
    events.onTorLog("error", "tor failed: $code")
    if (!wanted) return
    failures++
    val delay = (RETRY_BASE_MS shl (failures - 1).coerceAtMost(4)).coerceAtMost(RETRY_MAX_MS)
    retry = worker.schedule({ if (wanted && run == generation) launch() }, delay, TimeUnit.MILLISECONDS)
  }

  private fun teardown() {
    poll?.cancel(false)
    poll = null
    control?.let { runCatching { it.close() } }
    control = null
    connection?.let { runCatching { appContext.unbindService(it) } }
    connection = null
    if (endpointsSet) {
      synchronized(signal) { endpointsSet = false }
      events.onTorEndpoints("", "", "")
    }
  }

  private fun publish(state: String, progress: Int) {
    val next = Snapshot(state, progress)
    if (next == snapshot) return
    synchronized(signal) {
      snapshot = next
      signal.notifyAll()
    }
    events.onTorState(state, progress)
  }

  private fun awaitPreviousTorExit(): Boolean {
    val deadline = SystemClock.elapsedRealtime() + PREVIOUS_TOR_EXIT_MS
    while (Thread.getAllStackTraces().keys.any { it.name == TOR_THREAD_NAME && it.isAlive }) {
      if (SystemClock.elapsedRealtime() > deadline) return false
      SystemClock.sleep(100)
    }
    return true
  }

  // O torrc do app sobrepõe o torrc-defaults que o TorService escreve com a porta
  // SOCKS 9050 e a porta HTTP 8118: SOCKS em porta automática só no loopback e
  // sem o túnel HTTP, que o núcleo não usa.
  private fun writeTorrc() {
    val torrc = TorService.getTorrc(appContext)
    val temporary = File(torrc.parentFile, "torrc.tmp")
    temporary.writeText(TORRC, Charsets.UTF_8)
    if (!temporary.renameTo(torrc)) throw IOException("cannot replace torrc")
  }

  // Mesmo caminho que o TorService passa em --ControlSocket.
  private fun controlSocketFile(): File = File(File(TorService.getTorrc(appContext).parentFile, "data"), "ControlSocket")

  companion object {
    const val STATE_DISABLED = "disabled"
    const val STATE_STARTING = "starting"
    const val STATE_BOOTSTRAPPING = "bootstrapping"
    const val STATE_READY = "ready"
    const val STATE_FAILED = "failed"

    private const val TOR_THREAD_NAME = "tor"
    private const val SOCKS_LISTENERS = "net/listeners/socks"
    private const val BOOTSTRAP_PHASE = "status/bootstrap-phase"
    private const val STARTUP_POLL_MS = 500L
    private const val READY_POLL_MS = 10_000L
    private const val CONTROL_TIMEOUT_MS = 3_000
    private const val HANDOVER_TIMEOUT_MS = 30_000L
    private const val PREVIOUS_TOR_EXIT_MS = 15_000L
    private const val RETRY_BASE_MS = 5_000L
    private const val RETRY_MAX_MS = 60_000L

    private val TORRC = """
      SOCKSPort auto
      HTTPTunnelPort 0
      AvoidDiskWrites 1
      DormantCanceledByStartup 1
    """.trimIndent() + "\n"
  }
}

// Leitura das respostas do controle do tor, sem estado, para os testes da JVM.
internal object TorControlReplies {
  private val progressPattern = Regex("""\bPROGRESS=(\d{1,3})\b""")

  // Valor de uma linha "chave=valor" de GETINFO.
  fun value(key: String, lines: List<String>): String? =
    lines.firstOrNull { it.startsWith("$key=") }?.substring(key.length + 1)

  // Primeiro ouvinte SOCKS TCP no loopback, como "127.0.0.1:9050" ou "[::1]:9050".
  fun socksListener(value: String): String? =
    value.split(' ')
      .map { it.trim().removeSurrounding("\"") }
      .firstOrNull { listener ->
        val port = listener.substringAfterLast(':', "").toIntOrNull()
        val host = listener.substringBeforeLast(':', "")
        port != null && port in 1..65535 && (host == "127.0.0.1" || host == "[::1]")
      }

  fun bootstrapProgress(value: String): Int? {
    if (!value.contains(" BOOTSTRAP ")) return null
    val progress = progressPattern.find(value)?.groupValues?.get(1)?.toIntOrNull() ?: return null
    return progress.takeIf { it in 0..100 }
  }
}

// Conexão mínima ao ControlSocket com prazo de leitura, para uma consulta ao tor
// nunca prender a thread do runtime.
internal class TorControlSocket private constructor(private val socket: LocalSocket) : Closeable {
  private val reader = BufferedReader(InputStreamReader(socket.inputStream, Charsets.US_ASCII))
  private val writer: OutputStream = socket.outputStream

  fun authenticate() {
    command("AUTHENTICATE")
  }

  fun getInfo(key: String): String {
    val lines = command("GETINFO $key")
    return TorControlReplies.value(key, lines) ?: throw IOException("tor did not answer $key")
  }

  private fun command(line: String): List<String> {
    writer.write("$line\r\n".toByteArray(Charsets.US_ASCII))
    writer.flush()
    val reply = mutableListOf<String>()
    while (true) {
      val text = reader.readLine() ?: throw EOFException("tor control closed")
      if (text.length < 4) throw IOException("tor control sent a malformed line")
      val status = text.substring(0, 3)
      val separator = text[3]
      val body = text.substring(4)
      if (status.startsWith("6")) continue
      if (separator == '+') {
        val data = StringBuilder(body)
        while (true) {
          val next = reader.readLine() ?: throw EOFException("tor control closed")
          if (next == ".") break
          data.append('\n').append(if (next.startsWith("..")) next.substring(1) else next)
        }
        reply.add(data.toString())
        continue
      }
      reply.add(body)
      if (separator == ' ') {
        if (!status.startsWith("2")) throw IOException("tor control answered $status")
        return reply
      }
    }
  }

  override fun close() {
    socket.close()
  }

  companion object {
    fun open(path: File, timeoutMs: Int): TorControlSocket {
      val socket = LocalSocket()
      try {
        socket.connect(LocalSocketAddress(path.absolutePath, LocalSocketAddress.Namespace.FILESYSTEM))
        socket.soTimeout = timeoutMs
        return TorControlSocket(socket)
      } catch (error: IOException) {
        runCatching { socket.close() }
        throw error
      }
    }
  }
}
