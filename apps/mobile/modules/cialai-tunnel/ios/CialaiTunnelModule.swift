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
  private var logLevel = LogLevel.info
  private var backgrounded = false

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
      self.call(promise) { tunnel in
        try Self.decodeObject(Self.text {
          tunnel.pair(payload, deviceName: name, deviceModel: model, platform: platform, appVersion: app, error: $0)
        })
      }
    }

    AsyncFunction("connect") { (desktopId: String, promise: Promise) in
      self.call(promise) { tunnel in
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
      }
    }

    Function("notifyForeground") { (active: Bool) in
      self.queue.async { self.setForeground(active) }
    }

    AsyncFunction("forgetDesktop") { (desktopId: String, promise: Promise) in
      self.call(promise) { tunnel in
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
    try? tunnel?.stop()
    tunnel = nil
    listener = nil
    appliedTor = nil
  }

  /// Segundo plano pausa a rede do Tor, que não reinicia no mesmo processo; a volta retoma.
  private func setForeground(_ active: Bool) {
    backgrounded = !active
    if active {
      TorRuntime.shared.setNetworkEnabled(true)
      tunnel?.notifyForeground(true)
    } else {
      tunnel?.notifyForeground(false)
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

  // MARK: - Chamadas ao núcleo

  private func call(_ promise: Promise, _ operation: @escaping (MobileTunnel) throws -> Any?) {
    queue.async {
      guard let tunnel = self.tunnel else {
        promise.reject(self.unavailable())
        return
      }
      self.calls.async {
        do {
          let value = try operation(tunnel)
          promise.resolve(value)
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
