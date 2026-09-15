require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |spec|
  spec.name = 'CialaiTunnel'
  spec.version = package['version']
  spec.summary = 'Expo bridge for the Cialai mobile tunnel'
  spec.description = 'Wraps the gomobile Tunnelcore framework, runs Tor in process and reports local network discovery, without implementing the connection logic in Swift.'
  spec.license = 'Apache-2.0'
  spec.author = 'Ordinum'
  spec.homepage = 'https://github.com/Cialai/cialai'
  # O Tor pede iOS 15 ou mais novo; o piso de 16.4 vem do Expo e do app.
  spec.platforms = { :ios => '16.4' }
  spec.source = { :git => 'https://github.com/Cialai/cialai.git' }
  spec.static_framework = true
  spec.source_files = '**/*.{h,m,mm,swift}'
  # Os cabeçalhos do gomobile ficam dentro do framework; como fonte, entrariam no umbrella header do pod.
  spec.exclude_files = 'Tunnelcore.xcframework/**/*'
  spec.swift_version = '5.9'
  spec.dependency 'ExpoModulesCore'
  # Tor em processo pelo Tor.framework, com a versão fixa porque a API é declarada instável.
  # A mesma versão entra com cabeçalhos modulares em extraPods de app.config.ts.
  spec.dependency 'Tor', '409.11.2'
  spec.vendored_frameworks = 'Tunnelcore.xcframework'
  # A biblioteca estática do Go chama SecTrust e CFString; a descoberta local usa o Network.
  spec.frameworks = 'Security', 'CoreFoundation', 'Network'
end
