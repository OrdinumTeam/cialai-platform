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
  private let queue = DispatchQueue(label: "br.com.ordinum.cialai.tunnel")
  private var tunnel: MobileTunnel?
  private var listener: TunnelListener?

  public func definition() -> ModuleDefinition {
    Name("CialaiTunnel")
    Events("onTunnelEvent")

    OnCreate {
      do {
        let stateDirectory = try Self.prepareStateDirectory()
        let listener = TunnelListener(module: self)
        self.listener = listener
        // O gomobile exporta funções Go como funções C; o erro volta pelo ponteiro, não como throws.
        var creationError: NSError?
        guard let tunnel = MobileNewTunnel(stateDirectory.path, listener, &creationError) else {
          throw creationError ?? TunnelModuleError.unavailable
        }
        self.tunnel = tunnel
      } catch {
        self.tunnel = nil
      }
    }

    OnDestroy {
      self.queue.sync {
        try? self.tunnel?.stop()
        self.tunnel = nil
        self.listener = nil
      }
    }

    Function("version") {
      MobileVersion()
    }

    AsyncFunction("inspectPairPayload") { (payload: String) -> [String: Any] in
      try self.onQueue {
        let tunnel = try self.requireTunnel()
        return try Self.decodeObject(Self.text { tunnel.inspectPairPayload(payload, error: $0) })
      }
    }

    AsyncFunction("pair") { (payload: String, device: [String: String]) -> [String: Any] in
      try self.onQueue {
        guard let name = device["name"], let model = device["model"],
              let platform = device["platform"], let app = device["app"] else {
          throw TunnelModuleError.invalidDevice
        }
        let tunnel = try self.requireTunnel()
        return try Self.decodeObject(Self.text {
          tunnel.pair(payload, deviceName: name, deviceModel: model, platform: platform, appVersion: app, error: $0)
        })
      }
    }

    AsyncFunction("startProfile") { (profileId: String) in
      try self.onQueue { try self.requireTunnel().startProfile(profileId) }
    }

    AsyncFunction("stop") {
      try self.onQueue { try self.requireTunnel().stop() }
    }

    AsyncFunction("status") { () -> [String: Any] in
      try self.onQueue {
        let tunnel = try self.requireTunnel()
        return try Self.decodeObject(Self.text { tunnel.statusJSON($0) })
      }
    }

    AsyncFunction("openDesktop") { (desktopId: String, deviceToken: String, preferredPort: Int) -> [String: Any] in
      try self.onQueue {
        let tunnel = try self.requireTunnel()
        return try Self.decodeObject(Self.text {
          tunnel.openDesktop(desktopId, deviceToken: deviceToken, preferredPort: preferredPort, error: $0)
        })
      }
    }

    AsyncFunction("closeDesktop") { (desktopId: String) in
      try self.onQueue { try self.requireTunnel().closeDesktop(desktopId) }
    }

    Function("notifyNetworkChange") { (reachable: Bool) in
      self.queue.async { self.tunnel?.notifyNetworkChange(reachable) }
    }

    Function("notifyForeground") { (active: Bool) in
      self.queue.async { self.tunnel?.notifyForeground(active) }
    }

    AsyncFunction("forgetProfile") { (profileId: String) in
      try self.onQueue { try self.requireTunnel().forgetProfile(profileId) }
    }

    Function("setLogLevel") { (level: String) in
      self.queue.async { self.tunnel?.setLogLevel(level) }
    }
  }

  private func requireTunnel() throws -> MobileTunnel {
    guard let tunnel else { throw TunnelModuleError.unavailable }
    return tunnel
  }

  private func onQueue<T>(_ operation: () throws -> T) throws -> T {
    try queue.sync(execute: operation)
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
      throw TunnelModuleError.invalidResponse
    }
    return object
  }

  private static func prepareStateDirectory() throws -> URL {
    let base = try FileManager.default.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    let directory = base.appendingPathComponent("cialai/tunnel", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    var protectedDirectory = directory
    try protectedDirectory.setResourceValues(values)
    try FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
      ofItemAtPath: directory.path
    )
    return directory
  }
}

private enum TunnelModuleError: Error {
  case unavailable
  case invalidDevice
  case invalidResponse
}
