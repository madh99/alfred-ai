//
//  Generated file. Do not edit.
//

import FlutterMacOS
import Foundation

import audioplayers_darwin
import desktop_drop
import file_selector_macos
import hotkey_manager_macos
import local_notifier
import mobile_scanner
import package_info_plus
import record_macos
import screen_retriever_macos
import window_manager

func RegisterGeneratedPlugins(registry: FlutterPluginRegistry) {
  AudioplayersDarwinPlugin.register(with: registry.registrar(forPlugin: "AudioplayersDarwinPlugin"))
  DesktopDropPlugin.register(with: registry.registrar(forPlugin: "DesktopDropPlugin"))
  FileSelectorPlugin.register(with: registry.registrar(forPlugin: "FileSelectorPlugin"))
  HotkeyManagerMacosPlugin.register(with: registry.registrar(forPlugin: "HotkeyManagerMacosPlugin"))
  LocalNotifierPlugin.register(with: registry.registrar(forPlugin: "LocalNotifierPlugin"))
  MobileScannerPlugin.register(with: registry.registrar(forPlugin: "MobileScannerPlugin"))
  FPPPackageInfoPlusPlugin.register(with: registry.registrar(forPlugin: "FPPPackageInfoPlusPlugin"))
  RecordMacOsPlugin.register(with: registry.registrar(forPlugin: "RecordMacOsPlugin"))
  ScreenRetrieverMacosPlugin.register(with: registry.registrar(forPlugin: "ScreenRetrieverMacosPlugin"))
  WindowManagerPlugin.register(with: registry.registrar(forPlugin: "WindowManagerPlugin"))
}
