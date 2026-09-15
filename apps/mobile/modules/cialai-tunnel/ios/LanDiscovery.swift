// SPDX-License-Identifier: Apache-2.0
import Foundation
import Network

/// Descoberta dos computadores pareados na rede local por DNS-SD.
///
/// Só usa NWBrowser e NWConnection: nada abre socket multicast diretamente, o que
/// exigiria a capacidade `com.apple.developer.networking.multicast`. O sistema faz
/// as consultas mDNS e pede a permissão de Rede Local, declarada no Info.plist em
/// `NSLocalNetworkUsageDescription` e `NSBonjourServices`.
///
/// O computador anuncia `_cialai._udp` com TXT `v=1`, `id` e `fp`. Só instâncias com
/// o id de um computador pareado e com o fp que o próprio id determina são
/// resolvidas. A resolução abre uma NWConnection UDP por família de endereço, que
/// resolve o serviço e fica pronta sem enviar pacote; o endereço remoto do caminho
/// vira candidato. O núcleo Go valida o relatório e descarta o que não for rede
/// local. Nada disso autentica o computador: o TLS mútuo do caminho direto fixa a chave.
final class LanDiscovery {
  typealias Reporter = (_ desktopID: String, _ reportJSON: String) -> Void

  static let serviceType = "_cialai._udp"
  private static let maxReported = 8
  private static let resolveTimeout: TimeInterval = 3
  private static let restartDelay: TimeInterval = 2
  private static let desktopPrefix = "d_"
  private static let idBytes = 16
  private static let fingerprintBytes = 8

  private struct Candidate: Hashable {
    let host: String
    let port: UInt16
    let family: Int
  }

  private struct Instance {
    let desktopID: String
    var candidates: [Candidate] = []
    var resolvers: [Int: NWConnection] = [:]
  }

  private let queue = DispatchQueue(label: "br.com.ordinum.cialai.discovery")
  private let report: Reporter
  private var browser: NWBrowser?
  private var browserGeneration = 0
  private var known: Set<String> = []
  private var active = false
  private var stopped = false
  private var instances: [NWEndpoint: Instance] = [:]
  // Chave própria de cada resolução, para um prazo vencido nunca cancelar uma resolução mais nova.
  private var nextResolver = 0
  private var reported: [String: [Candidate]] = [:]

  init(report: @escaping Reporter) {
    self.report = report
  }

  /// Computadores pareados; a busca só roda com pelo menos um, para não pedir a
  /// permissão de Rede Local antes do primeiro pareamento.
  func update(known desktopIDs: Set<String>) {
    queue.async {
      self.known = desktopIDs
      self.reported = self.reported.filter { desktopIDs.contains($0.key) }
      self.reconcile()
      if let browser = self.browser { self.apply(browser.browseResults) }
    }
  }

  /// Primeiro plano liga a busca e segundo plano desliga; os candidatos já
  /// repassados ao núcleo continuam lá até a próxima resolução.
  func setActive(_ active: Bool) {
    queue.async {
      self.active = active
      self.reconcile()
    }
  }

  /// Mudança de rede: recomeça a busca para resolver os endereços de novo.
  func refresh() {
    queue.async {
      guard self.browser != nil else { return }
      self.stopBrowser()
      self.reconcile()
    }
  }

  func stop() {
    queue.async {
      self.stopped = true
      self.stopBrowser()
    }
  }

  /// Impressão digital curta que o id `d_` determina: hexadecimal dos 8 primeiros
  /// dos 16 bytes codificados em base64url.
  static func fingerprint(of desktopID: String) -> String? {
    guard desktopID.hasPrefix(desktopPrefix) else { return nil }
    var encoded = String(desktopID.dropFirst(desktopPrefix.count))
    guard !encoded.isEmpty, !encoded.contains("="), !encoded.contains("+"), !encoded.contains("/") else { return nil }
    encoded = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while encoded.count % 4 != 0 { encoded += "=" }
    guard let raw = Data(base64Encoded: encoded), raw.count == idBytes else { return nil }
    return raw.prefix(fingerprintBytes).map { String(format: "%02x", $0) }.joined()
  }

  private func reconcile() {
    let shouldRun = active && !stopped && !known.isEmpty
    if shouldRun && browser == nil { startBrowser() }
    if !shouldRun && browser != nil { stopBrowser() }
  }

  private func startBrowser() {
    browserGeneration += 1
    let generation = browserGeneration
    let parameters = NWParameters()
    parameters.includePeerToPeer = false
    let browser = NWBrowser(for: .bonjourWithTXTRecord(type: Self.serviceType, domain: "local."), using: parameters)
    browser.stateUpdateHandler = { [weak self] state in
      guard let self, generation == self.browserGeneration else { return }
      // `waiting` cobre a permissão negada; a busca segue sozinha quando ela é concedida.
      if case .failed = state {
        self.stopBrowser()
        self.queue.asyncAfter(deadline: .now() + Self.restartDelay) { self.reconcile() }
      }
    }
    browser.browseResultsChangedHandler = { [weak self] results, _ in
      guard let self, generation == self.browserGeneration else { return }
      self.apply(results)
    }
    self.browser = browser
    browser.start(queue: queue)
  }

  private func stopBrowser() {
    browserGeneration += 1
    browser?.stateUpdateHandler = nil
    browser?.browseResultsChangedHandler = nil
    browser?.cancel()
    browser = nil
    for instance in instances.values { cancel(instance) }
    instances.removeAll()
  }

  private func apply(_ results: Set<NWBrowser.Result>) {
    var seen: [NWEndpoint: String] = [:]
    for result in results {
      guard case .service = result.endpoint, case .bonjour(let record) = result.metadata else { continue }
      let entries = record.dictionary
      guard entries["v"] == "1", let id = entries["id"], known.contains(id),
            let fingerprint = entries["fp"], fingerprint == Self.fingerprint(of: id) else { continue }
      seen[result.endpoint] = id
    }
    var touched = Set<String>()
    for (endpoint, instance) in instances where seen[endpoint] != instance.desktopID {
      cancel(instance)
      instances[endpoint] = nil
      touched.insert(instance.desktopID)
    }
    for (endpoint, id) in seen where instances[endpoint] == nil {
      instances[endpoint] = Instance(desktopID: id)
      resolve(endpoint)
    }
    for id in touched { publish(id) }
  }

  private func resolve(_ endpoint: NWEndpoint) {
    for version in [NWProtocolIP.Options.Version.v4, .v6] {
      let parameters = NWParameters(dtls: nil, udp: NWProtocolUDP.Options())
      parameters.includePeerToPeer = false
      if let ip = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
        ip.version = version
      }
      let connection = NWConnection(to: endpoint, using: parameters)
      nextResolver += 1
      let key = nextResolver
      connection.stateUpdateHandler = { [weak self, weak connection] state in
        guard let self, let connection else { return }
        switch state {
        case .ready:
          self.finish(endpoint, key: key, path: connection.currentPath)
        case .waiting, .failed, .cancelled:
          self.finish(endpoint, key: key, path: nil)
        default:
          break
        }
      }
      instances[endpoint]?.resolvers[key] = connection
      connection.start(queue: queue)
      queue.asyncAfter(deadline: .now() + Self.resolveTimeout) { [weak self] in
        self?.finish(endpoint, key: key, path: nil)
      }
    }
  }

  private func finish(_ endpoint: NWEndpoint, key: Int, path: NWPath?) {
    guard var instance = instances[endpoint], let connection = instance.resolvers.removeValue(forKey: key) else { return }
    connection.stateUpdateHandler = nil
    connection.cancel()
    if case .hostPort(let host, let port)? = path?.remoteEndpoint, let literal = Self.literal(host) {
      let candidate = Candidate(host: literal.host, port: port.rawValue, family: literal.family)
      if !instance.candidates.contains(candidate) { instance.candidates.append(candidate) }
    }
    instances[endpoint] = instance
    publish(instance.desktopID)
  }

  private func cancel(_ instance: Instance) {
    for connection in instance.resolvers.values {
      connection.stateUpdateHandler = nil
      connection.cancel()
    }
  }

  /// Repassa ao núcleo os endereços de um computador quando eles mudam, IPv4 primeiro.
  private func publish(_ desktopID: String) {
    var candidates: [Candidate] = []
    for instance in instances.values where instance.desktopID == desktopID {
      for candidate in instance.candidates where !candidates.contains(candidate) {
        candidates.append(candidate)
      }
    }
    candidates.sort { ($0.family, $0.host, $0.port) < ($1.family, $1.host, $1.port) }
    let limited = Array(candidates.prefix(Self.maxReported))
    let previous = reported[desktopID]
    guard limited != (previous ?? []) else { return }
    guard let fingerprint = Self.fingerprint(of: desktopID) else { return }
    reported[desktopID] = limited.isEmpty ? nil : limited
    let entries = limited.map { ["host": $0.host, "port": Int($0.port), "id": desktopID, "fp": fingerprint] as [String: Any] }
    guard let data = try? JSONSerialization.data(withJSONObject: entries),
          let json = String(data: data, encoding: .utf8) else { return }
    report(desktopID, json)
  }

  private static func literal(_ host: NWEndpoint.Host) -> (host: String, family: Int)? {
    switch host {
    case .ipv4(let address):
      return format(address.rawValue, family: AF_INET).map { ($0, 4) }
    case .ipv6(let address):
      return format(address.rawValue, family: AF_INET6).map { ($0, 6) }
    default:
      return nil
    }
  }

  private static func format(_ raw: Data, family: Int32) -> String? {
    var buffer = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
    let written = raw.withUnsafeBytes { bytes in
      inet_ntop(family, bytes.baseAddress, &buffer, socklen_t(buffer.count)) != nil
    }
    guard written else { return nil }
    return buffer.withUnsafeBufferPointer { pointer in pointer.baseAddress.map { String(cString: $0) } }
  }
}
