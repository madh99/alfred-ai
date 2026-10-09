; Alfred Desktop-App — Inno Setup (Phase 4, M6). Aufruf über release/windows.cjs mit /DVersion=... /DQuelle=...
; Installation je Benutzer (kein Administrator), schließt eine laufende App, startet sie danach neu, Autostart wählbar.
#ifndef Version
  #define Version "0.0.0"
#endif
#ifndef Quelle
  #define Quelle "..\build\windows\x64\runner\Release"
#endif

[Setup]
AppId={{7A3D1F0E-5B1C-4C7E-9E2B-0A1F2E3D4C5B}
AppName=Alfred
AppVersion={#Version}
AppVerName=Alfred {#Version}
AppPublisher=Alfred
DefaultDirName={localappdata}\Programs\Alfred
DefaultGroupName=Alfred
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\build\installer
OutputBaseFilename=Alfred-{#Version}-setup
SetupIconFile=..\windows\runner\resources\app_icon.ico
UninstallDisplayIcon={app}\Alfred.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "de"; MessagesFile: "compiler:Languages\German.isl"

[Tasks]
Name: "autostart"; Description: "Alfred beim Anmelden starten"; GroupDescription: "Zusätzlich:"
Name: "desktopicon"; Description: "Verknüpfung auf dem Desktop"; GroupDescription: "Zusätzlich:"; Flags: unchecked

[Files]
Source: "{#Quelle}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Alfred"; Filename: "{app}\Alfred.exe"
Name: "{autodesktop}\Alfred"; Filename: "{app}\Alfred.exe"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Alfred"; ValueData: """{app}\Alfred.exe"""; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\Alfred.exe"; Description: "Alfred jetzt starten"; Flags: nowait postinstall skipifsilent
Filename: "{app}\Alfred.exe"; Flags: nowait runasoriginaluser; Check: WizardSilent
