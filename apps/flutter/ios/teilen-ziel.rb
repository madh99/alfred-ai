# „Teilen an Alfred“ (Owner 20.10.) — legt das Share-Erweiterungs-Ziel „Teilen“ im Runner-Projekt an und bettet es in die App
# ein. Wiederholbar: existiert das Ziel, passiert nichts. Aufruf am Mac (xcodeproj kommt mit CocoaPods): ruby ios/teilen-ziel.rb
require 'xcodeproj'

projekt = Xcodeproj::Project.open(File.join(__dir__, 'Runner.xcodeproj'))
if projekt.targets.any? { |t| t.name == 'Teilen' }
  puts 'Ziel Teilen existiert schon'
  exit 0
end
runner = projekt.targets.find { |t| t.name == 'Runner' } or abort 'Ziel Runner fehlt'

ziel = projekt.new_target(:app_extension, 'Teilen', :ios, '15.0', nil, :swift)
gruppe = projekt.main_group.new_group('Teilen', 'Teilen')
quelle = gruppe.new_reference('ShareViewController.swift')
gruppe.new_reference('Info.plist')
gruppe.new_reference('Teilen.entitlements')
xcconfig = gruppe.new_reference('Teilen.xcconfig')
ziel.add_file_references([quelle])

# gleiche Konfigurationen wie das Projekt (Flutter hat zusätzlich „Profile“)
projekt.build_configurations.map(&:name).each do |name|
  ziel.add_build_configuration(name, name == 'Debug' ? :debug : :release) unless ziel.build_configurations.any? { |c| c.name == name }
end
ziel.build_configurations.each do |c|
  c.base_configuration_reference = xcconfig
  b = c.build_settings
  b['PRODUCT_BUNDLE_IDENTIFIER'] = 'at.alfred.app.teilen'
  b['PRODUCT_NAME'] = 'Teilen'
  b['INFOPLIST_FILE'] = 'Teilen/Info.plist'
  b['GENERATE_INFOPLIST_FILE'] = 'NO'
  b['CODE_SIGN_ENTITLEMENTS'] = 'Teilen/Teilen.entitlements'
  b['CODE_SIGN_STYLE'] = 'Automatic'
  b['DEVELOPMENT_TEAM'] = 'T28LD8TF6X'
  b['SWIFT_VERSION'] = '5.0'
  b['IPHONEOS_DEPLOYMENT_TARGET'] = '15.0'
  b['TARGETED_DEVICE_FAMILY'] = '1,2'
  b['SKIP_INSTALL'] = 'YES'
  b['APPLICATION_EXTENSION_API_ONLY'] = 'YES'
  b['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
  b['MARKETING_VERSION'] = '$(FLUTTER_BUILD_NAME)'
  b['CURRENT_PROJECT_VERSION'] = '$(FLUTTER_BUILD_NUMBER)'
end

# in die App einbetten — vor den Skript-Phasen von Flutter/CocoaPods, sonst Abhängigkeits-Zyklus („Thin Binary“)
einbetten = runner.new_copy_files_build_phase('Embed Foundation Extensions')
einbetten.symbol_dst_subfolder_spec = :plug_ins
datei = einbetten.add_file_reference(ziel.product_reference, true)
datei.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
runner.build_phases.delete(einbetten)
stelle = runner.build_phases.index { |ph| ph.is_a?(Xcodeproj::Project::Object::PBXShellScriptBuildPhase) && ph.name == 'Thin Binary' } || runner.build_phases.length
runner.build_phases.insert(stelle, einbetten)
runner.add_dependency(ziel)

projekt.save
puts "Ziel Teilen angelegt (Konfigurationen: #{ziel.build_configurations.map(&:name).join(', ')})"
