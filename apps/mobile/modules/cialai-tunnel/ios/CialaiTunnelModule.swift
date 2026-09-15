// SPDX-License-Identifier: Apache-2.0
import ExpoModulesCore
import Foundation
import Tunnelcore

private final class TunnelListener: NSObject, MobileListenerProtocol {
  weak var module: CialaiTunnelModule?

  init(module: CialaiTunnelModule) {
    self.module = module
  }

  func onEvent(_ kind: String?, payloadJSON: String?) {
    guard let kind, let payloadJSON,
          let data = payloadJSON.data(using: .utf8),
          let payload = try? JSONSerialization.jsonObject(with: data) else {
      return
    }
    module?.sendEvent("onTunnelEvent", ["kind": kind, "payload": payload])
  }
}

public final class CialaiTunnelModule: Module {
  // Estado nativo: núcleo, endereços do Tor, descoberta e primeiro plano só mudam nesta fila serial.
  private let queue = DispatchQueue(label: "br.com.ordinum.cialai.tunnel")
  // Chamadas ao Go que esperam a rede, como `connect` com o orçamento da reserva, rodam fora da
  // fila serial e da fila compartilhada do Expo: `stop`, `status` e as notificações continuam
  // respondendo e podem cancelar uma conexão em andamento. O núcleo Go serializa o que precisa.
  private let calls = DispatchQueue(
    label: "br.com.ordinum.cialai.tunnel.calls",
    qos: .userInitiated,
    attributes: .concurrent
  )
  private var tunnel: MobileTunnel?
  private var listener: TunnelListener?
  private var startupError: Error?
  private var torListener: UUID?
  private var appliedTor: TorEndpoints?
  private var discovery: LanDiscovery?
  private var logLevel = LogLevel.info
  private var backgrounded = false
  // O iOS pode ter suspendido o app e recuperado os sockets: a próxima conexão pedida pelo
  // App depois de voltar ao primeiro plano começa do zero.
  private var freshStartPending = false

  public func definition() -> ModuleDefinition {
    Name("CialaiTunnel")
    Events("onTunnelEvent")

    OnCreate {
      self.queue.async { self.start() }
    }

    OnDestroy {
      self.queue.sync { self.shutdown() }
    }

    Function("version") {
      MobileVersion()
    }

    AsyncFunction("inspectPairPayload") { (payload: String, promise: Promise) in
      self.call(promise) { tunnel in
        try Self.decodeObject(Self.text { tunnel.inspectPairPayload(payload, error: $0) })
      }
    }

    AsyncFunction("pair") { (payload: String, device: [String: String], promise: Promise) in
      guard let name = device["name"], let model = device["model"],
            let platform = device["platform"], let app = device["app"] else {
        promise.reject(Self.failure("device_invalid", "Informe nome, modelo, plataforma e versão do aparelho."))
        return
      }
      self.call(promise, freshStart: true, then: { self.refreshDiscovery() }) { tunnel in
        try Self.decodeObject(Self.text {
          tunnel.pair(payload, deviceName: name, deviceModel: model, platform: platform, appVersion: app, error: $0)
        })
      }
    }

    AsyncFunction("connect") { (desktopId: String, promise: Promise) in
      self.call(promise, freshStart: true) { tunnel in
        try Self.decodeObject(Self.text { tunnel.connect(desktopId, error: $0) })
      }
    }

    AsyncFunction("openDesktop") { (desktopId: String, deviceToken: String, preferredPort: Int, promise: Promise) in
      self.call(promise) { tunnel in
        try Self.decodeObject(Self.text {
          tunnel.openDesktop(desktopId, deviceToken: deviceToken, preferredPort: preferredPort, error: $0)
        })
      }
    }

    AsyncFunction("closeDesktop") { (desktopId: String, promise: Promise) in
      self.call(promise) { tunnel in
        try tunnel.closeDesktop(desktopId)
        return nil
      }
    }

    AsyncFunction("stop") { (promise: Promise) in
      self.call(promise) { tunnel in
        try tunnel.stop()
        return nil
      }
    }

    AsyncFunction("status") { (promise: Promise) in
      self.call(promise) { tunnel in
        try Self.decodeObject(Self.text { tunnel.statusJSON($0) })
      }
    }

    AsyncFunction("desktops") { (promise: Promise) in
      self.call(promise) { tunnel in
        try Self.decodeObject(Self.text { tunnel.desktopsJSON($0) })
      }
    }

    Function("notifyNetworkChange") { (reachable: Bool) in
      self.queue.async {
        self.tunnel?.notifyNetworkChange(reachable)
        if reachable { self.discovery?.refresh() }
      }
    }

    Function("notifyForeground") { (active: Bool) in
      self.queue.async { self.setForeground(active) }
    }

    AsyncFunction("forgetDesktop") { (desktopId: String, promise: Promise) in
      self.call(promise, then: { self.refreshDiscovery() }) { tunnel in
        try tunnel.forgetDesktop(desktopId)
        return nil
      }
    }

    Function("setLogLevel") { (level: String) in
      self.queue.async {
        guard let parsed = LogLevel(rawValue: level) else { return }
        self.logLevel = parsed
        self.tunnel?.setLogLevel(level)
      }
    }
  }

  // MARK: - Ciclo de vida

  private func start() {
    do {
      let stateDirectory = try Self.prepareStateDirectory()
      let listener = TunnelListener(module: self)
      self.listener = listener
      // O gomobile exporta funções Go como funções C; o erro volta pelo ponteiro, não como throws.
      var creationError: NSError?
      guard let tunnel = MobileNewTunnel(stateDirectory.path, listener, &creationError) else {
        throw creationError ?? Self.failure("tunnel_unavailable", "O núcleo do túnel não abriu.")
      }
      self.tunnel = tunnel
    } catch {
      startupError = error
      return
    }

    discovery = LanDiscovery { [weak self] desktopID, reportJSON in
      self?.queue.async { self?.reportLan(desktopID, reportJSON) }
    }
    discovery?.setActive(!backgrounded)
    refreshDiscovery()

    torListener = TorRuntime.shared.addListener { [weak self] snapshot in
      self?.queue.async { self?.applyTor(snapshot) }
    }
    TorRuntime.shared.start()
    TorRuntime.shared.setNetworkEnabled(!backgrounded)
  }

  private func shutdown() {
    // O Tor fica: ele não reinicia no mesmo processo e um módulo recriado reaproveita o mesmo.
    if let torListener { TorRuntime.shared.removeListener(torListener) }
    torListener = nil
    discovery?.stop()
    discovery = nil
    try? tunnel?.stop()
    tunnel = nil
    listener = nil
    appliedTor = nil
  }

  /// No iOS o sistema suspende o app quando decide, sem tempo garantido em segundo plano.
  /// Ao sair, o núcleo pausa as melhorias de caminho, a busca local para e o Tor pausa a
  /// rede. Ao voltar, tudo retoma e a próxima conexão pedida pelo App refaz `Connect` e
  /// `OpenDesktop` do zero, porque as ligações e os sockets podem ter morrido na suspensão.
  private func setForeground(_ active: Bool) {
    if active {
      if backgrounded { freshStartPending = true }
      backgrounded = false
      TorRuntime.shared.setNetworkEnabled(true)
      discovery?.setActive(true)
      tunnel?.notifyForeground(true)
    } else {
      backgrounded = true
      tunnel?.notifyForeground(false)
      discovery?.setActive(false)
      TorRuntime.shared.setNetworkEnabled(false)
    }
  }

  private func applyTor(_ snapshot: TorSnapshot) {
    if let tunnel, snapshot.endpoints != appliedTor {
      let endpoints = snapshot.endpoints
      do {
        // Vazio limpa os endereços quando o Tor falha; o núcleo passa a responder reserve_unavailable.
        try tunnel.setTorEndpoints(
          endpoints?.socks ?? "",
          controlAddr: endpoints?.control ?? "",
          cookiePath: endpoints?.cookiePath ?? ""
        )
        appliedTor = endpoints
      } catch {
        log(.error, "tor endpoints refused: \(Self.code(of: error))")
      }
    }
    log(.debug, "tor \(snapshot.progress.state) \(snapshot.progress.progress)")
    sendEvent("onTunnelEvent", [
      "kind": "tor",
      "payload": ["state": snapshot.progress.state, "progress": snapshot.progress.progress]
    ])
  }

  // MARK: - Descoberta local

  private func refreshDiscovery() {
    guard let tunnel, let discovery else { return }
    do {
      let listed = try Self.decodeObject(Self.text { tunnel.desktopsJSON($0) })
      let desktops = listed["desktops"] as? [[String: Any]] ?? []
      discovery.update(known: Set(desktops.compactMap { $0["id"] as? String }))
    } catch {
      log(.error, "listing desktops for discovery failed: \(Self.code(of: error))")
    }
  }

  private func reportLan(_ desktopID: String, _ reportJSON: String) {
    guard let tunnel else { return }
    do {
      try tunnel.reportLanCandidates(desktopID, reportedJSON: reportJSON)
      log(.debug, "local network report for \(desktopID)")
    } catch {
      log(.info, "local network report refused: \(Self.code(of: error))")
    }
  }

  // MARK: - Chamadas ao núcleo

  private func call(
    _ promise: Promise,
    freshStart: Bool = false,
    then: (() -> Void)? = nil,
    _ operation: @escaping (MobileTunnel) throws -> Any?
  ) {
    queue.async {
      guard let tunnel = self.tunnel else {
        promise.reject(self.unavailable())
        return
      }
      let restart = freshStart && self.freshStartPending
      if restart { self.freshStartPending = false }
      self.calls.async {
        do {
          if restart {
            // Fecha proxy, caminho e socket QUIC antigos; a operação abre tudo de novo.
            try? tunnel.stop()
          }
          let value = try operation(tunnel)
          promise.resolve(value)
          if let then { self.queue.async(execute: then) }
        } catch {
          promise.reject(Self.exception(from: error))
        }
      }
    }
  }

  private func unavailable() -> Exception {
    if let startupError { return Self.exception(from: startupError) }
    return Self.failure("tunnel_unavailable", "O núcleo do túnel ainda não está pronto.")
  }

  // Métodos Go que devolvem texto e erro chegam ao Swift com o erro por ponteiro, sem throws.
  private static func text(_ operation: (NSErrorPointer) -> String) throws -> String {
    var error: NSError?
    let value = operation(&error)
    if let error { throw error }
    return value
  }

  private static func decodeObject(_ raw: String) throws -> [String: Any] {
    guard let data = raw.data(using: .utf8),
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw failure("invalid_response", "O núcleo do túnel devolveu uma resposta inválida.")
    }
    return object
  }

  /// Os erros do Go chegam como `codigo: mensagem`; a rejeição leva o código em `code` e a
  /// mensagem inteira, que o TypeScript também sabe ler.
  private static func exception(from error: Error) -> Exception {
    if let exception = error as? Exception { return exception }
    let message = (error as NSError).localizedDescription
    return Exception(name: "TunnelException", description: message, code: code(of: error))
  }

  private static func failure(_ code: String, _ message: String) -> Exception {
    Exception(name: "TunnelException", description: "\(code): \(message)", code: code)
  }

  private static func code(of error: Error) -> String {
    if let exception = error as? Exception { return exception.code }
    let message = (error as NSError).localizedDescription
    guard let separator = message.firstIndex(of: ":") else { return "tunnel_failed" }
    let prefix = message[..<separator]
    let valid = !prefix.isEmpty && prefix.allSatisfy { ($0 >= "a" && $0 <= "z") || $0 == "_" }
    return valid ? String(prefix) : "tunnel_failed"
  }

  private func log(_ level: LogLevel, _ message: String) {
    guard level <= logLevel else { return }
    sendEvent("onTunnelEvent", ["kind": "log", "payload": ["level": level.rawValue, "message": message]])
  }

  private static func prepareStateDirectory() throws -> URL {
    let base = try FileManager.default.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    let directory = base.appendingPathComponent("cialai/tunnel", isDirectory: true)
    try PrivateDirectory.prepare(directory, excludeFromBackup: true)
    return directory
  }
}

private enum LogLevel: String, Comparable {
  case error
  case info
  case debug

  private var rank: Int {
    switch self {
    case .error: return 0
    case .info: return 1
    case .debug: return 2
    }
  }

  static func < (left: LogLevel, right: LogLevel) -> Bool {
    left.rank < right.rank
  }
}
