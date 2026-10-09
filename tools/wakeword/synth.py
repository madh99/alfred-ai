"""Synthese der Trainingsdaten mit Piper-TTS (deutsche Stimmen).

Positiv: „Alfred" allein und in Sätzen („Alfred, …", „Hey Alfred", „… Alfred?"), mehrere Stimmen, Tempo-/Tonhöhen-Varianten.
Negativ: ähnliche Wörter (Alfons, Albert, Alfredo, alles fertig, Manfred), Alltagssätze, Zahlen, Namen.
Augmentierung danach in train.py (Rauschen, Hall, Lautstärke, Versatz), damit die Rohdaten klein bleiben.

Ausgabe: /data/pos/*.wav, /data/neg/*.wav (16 kHz mono 16 bit, 1,5 s) und /data/manifest.json.
"""
import argparse, json, os, random, subprocess, sys, urllib.request
from pathlib import Path
import numpy as np
import soundfile as sf

VOICES = {
    # Piper-Stimmen (deutsch); werden bei Bedarf von Hugging Face geladen
    'thorsten-medium': 'de/de_DE/thorsten/medium/de_DE-thorsten-medium',
    'thorsten-high': 'de/de_DE/thorsten/high/de_DE-thorsten-high',
    'karlsson-low': 'de/de_DE/karlsson/low/de_DE-karlsson-low',
    'eva_k-x_low': 'de/de_DE/eva_k/x_low/de_DE-eva_k-x_low',
    'ramona-low': 'de/de_DE/ramona/low/de_DE-ramona-low',
    'pavoque-low': 'de/de_DE/pavoque/low/de_DE-pavoque-low',
    'kerstin-low': 'de/de_DE/kerstin/low/de_DE-kerstin-low',
}
BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/'

POS = ['Alfred', 'Alfred!', 'Alfred?', 'Hey Alfred', 'Alfred, bitte', 'Alfred, wie spät ist es', 'Du, Alfred', 'Also Alfred',
       'Alfred, kannst du', 'Okay Alfred', 'Alfred, mach', 'Hallo Alfred']
NEG = ['Alfons', 'Albert', 'Alfredo', 'alles fertig', 'Manfred', 'Alfreds Auto', 'Elfriede', 'alle Fenster', 'Alpen', 'Adler',
       'Wie spät ist es', 'Mach das Licht aus', 'Guten Morgen', 'Danke schön', 'Was gibt es heute', 'Das Wetter ist schön',
       'Ich gehe jetzt einkaufen', 'Ruf mich später an', 'Die Kinder schlafen', 'Zwei Kaffee bitte', 'Hallo zusammen',
       'Der Zug fährt um acht', 'Bitte leise', 'Ja genau', 'Nein danke', 'Komm her', 'Fertig', 'Alles klar', 'Hast du Zeit',
       'Eins zwei drei', 'Markus', 'Alexandra', 'Telefon', 'Kalender', 'Küche', 'Musik an', 'Fernseher aus']

def lade_stimme(name: str, ziel: Path) -> Path:
    rel = VOICES[name]
    onnx = ziel / f'{name}.onnx'
    if not onnx.exists():
        for ext in ('.onnx', '.onnx.json'):
            url = f'{BASE}{rel}{ext}'
            print('lade', url, file=sys.stderr)
            urllib.request.urlretrieve(url, ziel / f'{name}{ext}')
    return onnx

def piper(text: str, modell: Path, laenge: float, rausch: float) -> np.ndarray:
    """Ruft piper als Prozess auf (raw 16-bit, Sample-Rate aus der Modellkonfiguration) und resampled auf 16 kHz."""
    cfg = json.loads((modell.with_suffix('.onnx.json')).read_text())
    sr = int(cfg['audio']['sample_rate'])
    p = subprocess.run(['piper', '--model', str(modell), '--output-raw', '--length_scale', f'{laenge:.2f}', '--noise_scale', f'{rausch:.2f}'],
                       input=text.encode('utf-8'), capture_output=True, check=True)
    audio = np.frombuffer(p.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    if sr != 16000:
        import torch, torchaudio
        audio = torchaudio.functional.resample(torch.from_numpy(audio), sr, 16000).numpy()
    return audio

def fenster(audio: np.ndarray, sek: float = 1.5, sr: int = 16000) -> np.ndarray:
    n = int(sek * sr)
    if len(audio) >= n:
        # Wort mittig behalten
        start = max(0, (len(audio) - n) // 2)
        return audio[start:start + n]
    pad = n - len(audio)
    links = random.randint(0, pad)
    return np.concatenate([np.zeros(links, np.float32), audio, np.zeros(pad - links, np.float32)])

def main(argv) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='/data'); ap.add_argument('--n', type=int, default=1500); ap.add_argument('--voices', default=','.join(VOICES.keys()))
    a = ap.parse_args(argv)
    out = Path(a.out); (out / 'pos').mkdir(parents=True, exist_ok=True); (out / 'neg').mkdir(parents=True, exist_ok=True); (out / 'voices').mkdir(exist_ok=True)
    stimmen = [lade_stimme(v, out / 'voices') for v in a.voices.split(',') if v in VOICES]
    manifest = []
    random.seed(7)
    for i in range(a.n):
        pos = i % 2 == 0
        text = random.choice(POS if pos else NEG)
        modell = random.choice(stimmen)
        laenge = random.uniform(0.8, 1.3); rausch = random.uniform(0.3, 0.8)
        try:
            audio = piper(text, modell, laenge, rausch)
        except subprocess.CalledProcessError as e:
            print('piper-Fehler', text, e.stderr[:200], file=sys.stderr); continue
        clip = fenster(audio)
        name = f'{"pos" if pos else "neg"}/{i:05d}.wav'
        sf.write(out / name, clip, 16000, subtype='PCM_16')
        manifest.append({'datei': name, 'label': 1 if pos else 0, 'text': text, 'stimme': modell.stem, 'laenge': laenge})
        if i % 100 == 0: print(i, name, text, modell.stem, file=sys.stderr)
    (out / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=0))
    print('fertig:', len(manifest), 'Clips', sum(m['label'] for m in manifest), 'positiv')

if __name__ == '__main__':
    main(sys.argv[1:])
