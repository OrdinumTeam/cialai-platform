// SPDX-License-Identifier: Apache-2.0
import Foundation
import Tor

/// Listeners do Tor em processo no formato que `SetTorEndpoints` do núcleo Go aceita.
struct TorEndpoints: Equatable {
  let socks: String
  let control: String
  let cookiePath: String
}

/// Estado do Tor no vocabulário do evento `tor` do contrato v2.
struct TorProgress: Equatable {
  let state: String
  let progress: Int

  static let disabled = TorProgress(state: "disabled", progress: 0)
  static let starting = TorProgress(state: "starting", progress: 0)
  static let failed = TorProgress(state: "failed", progress: 0)

  static func bootstrap(_ progress: Int) -> TorProgress {
    let clamped = min(100, max(0, progress))
    return TorProgress(state: clamped >= 100 ? "ready" : "bootstrapping", progress: clamped)
  }
}

struct TorSnapshot: Equatable {
  let progress: TorProgress
  let endpoints: TorEndpoints?
}

/// Pastas privadas do app: dono só, protegidas até o primeiro desbloqueio e fora do backup.
enum PrivateDirectory {
  static func prepare(_ directory: URL, excludeFromBackup: Bool, fileManager: FileManager = .default) throws {
    let attributes: [FileAttributeKey: Any] = [
      .posixPermissions: 0o700,
      .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication
    ]
    try fileManager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: attributes)
    // Os atributos da criação não valem para uma pasta que já existia.
    try fileManager.setAttributes(attributes, ofItemAtPath: directory.path)
    if excludeFromBackup {
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      var target = directory
      try target.setResourceValues(values)
    }
  }
}

/// Onde o Tor guarda estado e ouve o controle.
struct TorLayout {
  enum Control {
    case socket(URL)
    // Porta TCP em loopback escolhida pelo Tor e escrita em `controlport`.
    case port
  }

  // `sun_path` do Darwin tem 104 bytes com o terminador.
  private static let socketPathLimit = 103

  let dataDirectory: URL
  let control: Control

  var cookieFile: URL { dataDirectory.appendingPathComponent("control_auth_cookie") }
  var controlPortFile: URL { dataDirectory.appendingPathComponent("controlport") }

  static func prepare(fileManager: FileManager = .default) throws -> TorLayout {
    let support = try fileManager.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    let data = support.appendingPathComponent("cialai/tor", isDirectory: true)
    try PrivateDirectory.prepare(data, excludeFromBackup: true, fileManager: fileManager)
    // Um cookie ou uma porta de uma execução anterior levariam a autenticar com o valor velho.
    let layout = TorLayout(dataDirectory: data, control: .port)
    try? fileManager.removeItem(at: layout.cookieFile)
    try? fileManager.removeItem(at: layout.controlPortFile)

    // O caminho do contêiner em Application Support passa do limite do socket Unix no
    // aparelho; `tmp/tor/ctl` cabe com folga e já fica fora do backup. No simulador o
    // caminho é longo demais e o controle cai para a porta em loopback.
    let socketDirectory = fileManager.temporaryDirectory.appendingPathComponent("tor", isDirectory: true)
    let socket = socketDirectory.appendingPathComponent("ctl")
    guard socket.path.utf8.count <= socketPathLimit else { return layout }
    try PrivateDirectory.prepare(socketDirectory, excludeFromBackup: false, fileManager: fileManager)
    try? fileManager.removeItem(at: socket)
    return TorLayout(dataDirectory: data, control: .socket(socket))
  }
}

/// Tor em processo pelo Tor.framework, compartilhado pelo processo inteiro.
///
/// O tor em C roda uma única vez por processo: `tor_run_main` não pode ser chamado
/// de novo depois de terminar e `TORThread` recusa uma segunda instância. Por isso
/// nada aqui encerra o Tor, nem quando o módulo Expo é destruído e recriado. Parar
/// vira pausar a rede com `SETCONF DisableNetwork=1` pelo controle e voltar é
/// `DisableNetwork=0`, que reaproveita consenso e guardas em cache e refaz os
/// circuitos. `TORController.disconnect()` nunca é chamado, porque envia
/// `SIGNAL SHUTDOWN`. Se a thread do Tor terminar por erro, o estado fica `failed`
/// até o app ser aberto de novo.
final class TorRuntime {
  typealias Listener = (TorSnapshot) -> Void

  static let shared = TorRuntime()

  private static let controlRetry: TimeInterval = 0.25
  // 30 s para o Tor abrir o controle depois de iniciar a thread.
  private static let controlAttempts = 120

  private let queue = DispatchQueue(label: "br.com.ordinum.cialai.tor")
  private var layout: TorLayout?
  private var thread: TorThread?
  private var control: TorControl?
  // Ligação ainda autenticando; as respostas guardam só referências fracas ao controle.
  private var pending: TorControl?
  private var controlAddress: String?
  private var statusObserver: Any?
  // Cada tentativa de ligar ao controle tem uma geração; respostas de uma ligação descartada são ignoradas.
  private var generation = 0
  private var networkEnabled = true
  private var snapshot = TorSnapshot(progress: .disabled, endpoints: nil)
  private var listeners: [UUID: Listener] = [:]

  private init() {}

  /// Registra quem acompanha o Tor e entrega o estado atual em seguida, na fila do Tor.
  func addListener(_ listener: @escaping Listener) -> UUID {
    let id = UUID()
    queue.async {
      self.listeners[id] = listener
      listener(self.snapshot)
    }
    return id
  }

  func removeListener(_ id: UUID) {
    queue.async { self.listeners[id] = nil }
  }

  /// Inicia o Tor na primeira chamada do processo; as seguintes não fazem nada.
  func start() {
    queue.async {
      guard self.thread == nil else { return }
      guard TorThread.active == nil else {
        self.publish(TorSnapshot(progress: .failed, endpoints: nil))
        return
      }
      let layout: TorLayout
      do {
        layout = try TorLayout.prepare()
      } catch {
        self.publish(TorSnapshot(progress: .failed, endpoints: nil))
        return
      }
      let thread = TorThread(configuration: Self.configuration(for: layout))
      self.layout = layout
      self.thread = thread
      thread.start()
      self.publish(TorSnapshot(progress: .starting, endpoints: nil))
      self.scheduleControl(attempt: 0, delay: Self.controlRetry)
    }
  }

  /// Pausa ou retoma a rede do Tor. Retomar confere o controle e o bootstrap de novo,
  /// porque o sistema pode ter suspendido o app com as ligações abertas.
  func setNetworkEnabled(_ enabled: Bool) {
    queue.async {
      let changed = self.networkEnabled != enabled
      self.networkEnabled = enabled
      if self.thread?.isFinished == true {
        self.threadExited()
        return
      }
      guard let control = self.control, changed || enabled else { return }
      control.send("SETCONF", ["DisableNetwork=\(enabled ? 0 : 1)"]) { [weak control] code, _ in
        guard enabled, code == TorControl.ok, let control else { return }
        self.refreshListeners(control)
      }
    }
  }

  private static func configuration(for layout: TorLayout) -> TorConfiguration {
    let configuration = TorConfiguration()
    configuration.ignoreMissingTorrc = true
    configuration.cookieAuthentication = true
    configuration.avoidDiskWrites = true
    configuration.clientOnly = true
    configuration.dataDirectory = layout.dataDirectory
    switch layout.control {
    case .socket(let url):
      configuration.controlSocket = url
    case .port:
      configuration.autoControlPort = true
    }
    #if DEBUG
    let log = "notice stdout"
    #else
    let log = "err stdout"
    #endif
    configuration.options.addEntries(from: [
      // Porta livre escolhida pelo Tor e só para endereços onion, que é tudo o que o núcleo disca.
      "SocksPort": "auto OnionTrafficOnly",
      "SafeLogging": "1",
      "Log": log
    ])
    return configuration
  }

  private func publish(_ next: TorSnapshot) {
    guard next != snapshot else { return }
    snapshot = next
    for listener in listeners.values { listener(next) }
  }

  /// A thread do Tor só termina por erro; quem nota é a próxima ligação ou comando ao controle.
  private func threadExited() {
    generation += 1
    dropControl()
    publish(TorSnapshot(progress: .failed, endpoints: nil))
  }

  private func scheduleControl(attempt: Int, delay: TimeInterval) {
    generation += 1
    let current = generation
    queue.asyncAfter(deadline: .now() + delay) {
      self.connectControl(generation: current, attempt: attempt)
    }
  }

  private func connectControl(generation current: Int, attempt: Int) {
    guard current == generation, let layout, let thread else { return }
    guard !thread.isFinished else {
      threadExited()
      return
    }
    guard attempt < Self.controlAttempts else {
      publish(TorSnapshot(progress: .failed, endpoints: nil))
      return
    }
    guard let made = makeController(layout),
          let cookie = try? Data(contentsOf: layout.cookieFile), !cookie.isEmpty else {
      scheduleControl(attempt: attempt + 1, delay: Self.controlRetry)
      return
    }
    let control = TorControl(controller: made.controller, queue: queue)
    control.onTimeout = { [weak self, weak control] in
      guard let self, let control, self.control === control || self.pending === control else { return }
      self.dropControl()
      self.scheduleControl(attempt: attempt + 1, delay: Self.controlRetry)
    }
    pending = control
    let hex = cookie.map { String(format: "%02x", $0) }.joined()
    control.send("AUTHENTICATE", [hex]) { [weak control] code, _ in
      guard current == self.generation, let control, self.pending === control else { return }
      self.pending = nil
      guard code == TorControl.ok else {
        // Cookie ainda da execução anterior ou controle recém aberto: tenta de novo.
        self.scheduleControl(attempt: attempt + 1, delay: Self.controlRetry)
        return
      }
      self.control = control
      self.controlAddress = made.address
      self.controlReady(control, generation: current)
    }
  }

  private func makeController(_ layout: TorLayout) -> (controller: TorController, address: String)? {
    switch layout.control {
    case .socket(let url):
      // Sem o arquivo do socket o TORController deixaria um descritor aberto a cada tentativa.
      guard FileManager.default.fileExists(atPath: url.path) else { return nil }
      let controller = TorController(socketURL: url)
      return controller.isConnected ? (controller, "unix:" + url.path) : nil
    case .port:
      guard let contents = try? String(contentsOf: layout.controlPortFile, encoding: .utf8),
            let endpoint = Self.controlPort(contents) else { return nil }
      let controller = TorController(socketHost: endpoint.host, port: endpoint.port)
      return controller.isConnected ? (controller, "\(endpoint.host):\(endpoint.port)") : nil
    }
  }

  private func controlReady(_ control: TorControl, generation current: Int) {
    statusObserver = control.controller.addObserver(forStatusEvents: { [weak self] type, _, action, arguments in
      guard type == "STATUS_CLIENT", action == "BOOTSTRAP" else { return false }
      if let progress = arguments?["PROGRESS"].flatMap({ Int($0) }) {
        self?.queue.async {
          guard let self, current == self.generation else { return }
          self.publish(TorSnapshot(progress: .bootstrap(progress), endpoints: self.snapshot.endpoints))
        }
      }
      return true
    })
    control.send("SETEVENTS", ["STATUS_CLIENT"]) { _, _ in }
    control.send("SETCONF", ["DisableNetwork=\(networkEnabled ? 0 : 1)"]) { _, _ in }
    refreshListeners(control)
  }

  /// Relê a porta SOCKS e o bootstrap e publica os endereços para o núcleo Go.
  private func refreshListeners(_ control: TorControl) {
    control.send("GETINFO", ["net/listeners/socks"]) { [weak control] code, lines in
      guard let control, self.control === control,
            let layout = self.layout, let controlAddress = self.controlAddress else { return }
      guard code == TorControl.ok,
            let socks = TorControl.value(of: "net/listeners/socks", in: lines).flatMap(Self.socksAddress) else {
        self.publish(TorSnapshot(progress: .failed, endpoints: nil))
        return
      }
      let endpoints = TorEndpoints(socks: socks, control: controlAddress, cookiePath: layout.cookieFile.path)
      control.send("GETINFO", ["status/bootstrap-phase"]) { [weak control] code, lines in
        guard let control, self.control === control else { return }
        var progress = self.snapshot.progress
        if code == TorControl.ok,
           let phase = TorControl.value(of: "status/bootstrap-phase", in: lines),
           let value = Self.bootstrapProgress(phase) {
          progress = .bootstrap(value)
        } else if progress.state == TorProgress.starting.state || progress.state == TorProgress.failed.state {
          progress = .bootstrap(0)
        }
        self.publish(TorSnapshot(progress: progress, endpoints: endpoints))
      }
    }
  }

  private func dropControl() {
    if let statusObserver { control?.controller.removeObserver(statusObserver) }
    statusObserver = nil
    control = nil
    pending = nil
    controlAddress = nil
  }

  /// `PORT=127.0.0.1:49651`, como o Tor escreve em `ControlPortWriteToFile`.
  static func controlPort(_ contents: String) -> (host: String, port: in_port_t)? {
    for line in contents.split(whereSeparator: \.isNewline) {
      guard line.hasPrefix("PORT="), let address = socksAddress(String(line.dropFirst(5))) else { continue }
      let parts = address.split(separator: ":")
      if parts.count == 2, let port = in_port_t(parts[1]) { return (String(parts[0]), port) }
    }
    return nil
  }

  /// Primeiro listener IPv4 em loopback de `"127.0.0.1:9050" ...`.
  static func socksAddress(_ value: String) -> String? {
    for token in value.split(separator: " ") {
      let address = token.trimmingCharacters(in: CharacterSet(charactersIn: "\""))
      let parts = address.split(separator: ":")
      guard parts.count == 2, parts[0] == "127.0.0.1", let port = UInt16(parts[1]), port > 0 else { continue }
      return address
    }
    return nil
  }

  /// `NOTICE BOOTSTRAP PROGRESS=45 TAG=... SUMMARY="..."`.
  static func bootstrapProgress(_ phase: String) -> Int? {
    for token in phase.split(separator: " ") where token.hasPrefix("PROGRESS=") {
      return Int(token.dropFirst("PROGRESS=".count))
    }
    return nil
  }
}

/// Comandos ao controle do Tor, um por vez e com prazo.
///
/// O TORController entrega cada resposta ao observador registrado por último, então
/// dois comandos pendentes trocariam as respostas. Um comando sem resposta no prazo
/// indica ligação morta, por exemplo depois de uma suspensão, e chama `onTimeout`.
final class TorControl {
  typealias Reply = (_ code: Int?, _ lines: [String]) -> Void

  static let ok = 250
  private static let asyncEvent = 650
  private static let timeout: TimeInterval = 3

  let controller: TorController
  var onTimeout: (() -> Void)?

  private let queue: DispatchQueue
  private var waiting: [(command: String, arguments: [String], reply: Reply)] = []
  private var inFlight = false
  private var serial = 0

  init(controller: TorController, queue: DispatchQueue) {
    self.controller = controller
    self.queue = queue
  }

  /// Chamado na fila do Tor; a resposta também chega nela.
  func send(_ command: String, _ arguments: [String] = [], reply: @escaping Reply) {
    waiting.append((command, arguments, reply))
    next()
  }

  static func value(of key: String, in lines: [String]) -> String? {
    let prefix = key + "="
    guard let line = lines.first(where: { $0.hasPrefix(prefix) }) else { return nil }
    return String(line.dropFirst(prefix.count))
  }

  private func next() {
    guard !inFlight, !waiting.isEmpty else { return }
    let item = waiting.removeFirst()
    inFlight = true
    serial += 1
    let current = serial
    controller.sendCommand(item.command, arguments: item.arguments, data: nil) { [weak self] codes, lines, stop in
      guard let code = codes.first?.intValue, code != TorControl.asyncEvent else { return false }
      stop.pointee = true
      let text = lines.map { String(decoding: $0, as: UTF8.self) }
      self?.queue.async { self?.finish(current, code: code, lines: text, reply: item.reply) }
      return true
    }
    queue.asyncAfter(deadline: .now() + Self.timeout) { [weak self] in
      guard let self, self.inFlight, self.serial == current else { return }
      self.inFlight = false
      self.waiting.removeAll()
      item.reply(nil, [])
      self.onTimeout?()
    }
  }

  private func finish(_ current: Int, code: Int, lines: [String], reply: Reply) {
    guard inFlight, serial == current else { return }
    inFlight = false
    reply(code, lines)
    next()
  }
}
