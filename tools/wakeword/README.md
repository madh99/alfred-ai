# Aktivierungswort „Alfred" — eigenes Modell (Owner-Freigabe 09.10.2026)

Ziel: ein kleines, lokales Modell, das das Wort „Alfred" (deutsch) im Mikrofonstrom erkennt, ohne Anbieter und ohne
Cloud. Erst wenn es erkannt wurde, geht Audio an das Hör-Relais.

## Weg
1. **Synthese** (`synth.py`): Piper-TTS mit deutschen Stimmen spricht „Alfred" in vielen Varianten (Stimme, Tempo,
   Tonhöhe, Satzkontext „Alfred, …", „Hey Alfred") sowie Negativbeispiele (andere Wörter und Sätze, ähnliche Wörter wie
   „Alfons", „Albert", „alles fertig"). Augmentierung: Rauschen, Hall, Lautstärke, Zeitversatz.
2. **Echte Aufnahmen** (Owner, Alexandra): 20 × „Alfred", 20 × andere Sätze. Sie werden NICHT nur zum Training, sondern
   vor allem zum Messen genutzt (Hold-out), damit die Zahlen etwas bedeuten.
3. **Training** (`train.py`): Log-Mel-Spektrogramm 16 kHz, 1,5-s-Fenster; kleines CNN (< 300 KB); Export nach ONNX.
4. **Messung**: Trefferquote auf echten Aufnahmen, Fehlauslösungen pro Stunde auf einem Tag Hintergrundgeräusch/Sprache.
5. **Laufzeit**: ONNX in der Desktop-App (Flutter `onnxruntime`) auf dem PCM-Strom, der heute schon für das Hör-Relais
   läuft; Schwellwert und Mindestabstand zwischen Treffern einstellbar.

## Umgebung
Docker auf der .96 (4 Kerne, 7 GB): `docker build -t alfred-wakeword tools/wakeword` und
`docker run --rm -v $PWD/data:/data alfred-wakeword synth` bzw. `… train`. CPU reicht; Synthese ~Minuten, Training ~Stunden.

## Stand
09.10.2026: Werkzeug angelegt, Synthese läuft (siehe Phase-4-Spec, Abschnitt Aktivierungswort). Echte Aufnahmen offen.
