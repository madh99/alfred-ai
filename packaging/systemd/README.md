# Alfred — systemd Service Unit

Saubere Service-Verwaltung ohne `nohup` und die damit verbundene Start-Race (siehe v603 CHANGELOG).

## Installation

```bash
# 1. Unit-Datei nach /etc/systemd/system/ kopieren
sudo cp packaging/systemd/alfred.service /etc/systemd/system/alfred.service

# 2. (Optional) Pfade in der Unit anpassen, falls dein Setup von /root/alfred abweicht
sudo nano /etc/systemd/system/alfred.service

# 3. systemd reload
sudo systemctl daemon-reload

# 4. Aktivieren (auto-start beim Boot) + starten
sudo systemctl enable alfred --now

# 5. Status prüfen
sudo systemctl status alfred
```

## Bedienung

| Befehl | Wirkung |
|---|---|
| `sudo systemctl start alfred` | Starten |
| `sudo systemctl stop alfred` | Stoppen (sendet SIGTERM → alfred.stop()) |
| `sudo systemctl restart alfred` | Neustart |
| `sudo systemctl status alfred` | Status + letzte 10 Log-Zeilen |
| `journalctl -u alfred -f` | Live-Logs verfolgen (stdout/stderr) |
| `journalctl -u alfred --since "10 min ago"` | Logs der letzten 10 min |
| `sudo systemctl disable alfred` | Auto-Start deaktivieren |

## Migration von `nohup`-Setup

```bash
# Alten nohup-Prozess stoppen
sudo killall -TERM node && sleep 5

# Service starten
sudo systemctl enable alfred --now

# Alte nohup.out-Datei archivieren oder löschen
sudo mv /root/alfred/nohup.out /root/alfred/nohup.out.archive
```

## Wie es das Doppel-Start-Problem löst

Die `nohup alfred start &` Startmethode hat ein Race-Window von ~30ms, in dem `stdout`
auf einen TTY-fd der eigentlich-schon-terminierten Subshell zeigt. Wenn ein Module-Level
`console.log` während dieses Fensters feuert, gibt's einen `EIO write` Uncaught Exception
→ Alfred crash't sofort beim ersten Start, läuft erst beim zweiten Versuch durch.

systemd hingegen setzt stdin/stdout/stderr **vor** dem Process-Exec auf das journald-Socket.
Es gibt keinen Übergangszustand, kein EIO, kein Doppel-Start.

## Cluster-Setup

Auf beiden HA-Nodes (`.92` und `.93`) gleich installieren. Jeder Node startet seine eigene
Alfred-Instanz; der `AdapterClaimManager` koordiniert via Postgres welcher Node welchen
Messaging-Adapter aktiv beansprucht.

## Hardening

Nach erfolgreichem ersten Start kannst du die auskommentierten Hardening-Direktiven
aktivieren. Wichtig: `ProtectHome=read-only` würde verhindern dass project-agent Sessions
in Homes der User schreiben — daher nur aktivieren wenn project-agent-Workspaces unter
`/root/alfred/...` oder `/var/lib/alfred/...` liegen.
