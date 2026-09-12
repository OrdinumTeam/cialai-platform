require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |spec|
  spec.name = 'CialaiTunnel'
  spec.version = package['version']
  spec.summary = 'Expo bridge for the Cialai mobile tunnel'
  spec.description = 'Wraps the gomobile Tunnelcore framework without implementing network logic in Swift.'
  spec.license = 'Apache-2.0'
  spec.author = 'Ordinum'
  spec.homepage = 'https://github.com/OrdinumTeam/cialai-platform'
  spec.platforms = { :ios => '16.4' }
  spec.source = { :git => 'https://github.com/OrdinumTeam/cialai-platform.git' }
  spec.static_framework = true
  spec.source_files = '**/*.{h,m,mm,swift}'
  spec.swift_version = '5.9'
  spec.dependency 'ExpoModulesCore'
  spec.vendored_frameworks = 'Tunnelcore.xcframework'
end
