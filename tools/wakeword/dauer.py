"""Dauerlauf-Messung (10.10.): eine lange Aufnahme (Minuten) wie in der App durchlaufen — Einbettung je Frame, Kopf, Regel
„k aufeinanderfolgende Fenster über der Schwelle", danach Sperre von 2 s. Zählt Auslösungen je Minute/Stunde und listet
die Zeitpunkte. Für Dauer-Negative (Gespräch, Fernseher) = Fehlauslösungen je Stunde; für Dauer-Positive („Alfred" alle
paar Sekunden) = Treffer gegen die erwartete Anzahl.

Aufruf: dauer --datei /data/dauerpositiv/Dauerpositiv_269.m4a [--kopf /data/app-modell/oww-kopf.onnx] [--schwelle 0.95] [--fenster 3]
"""
import argparse, subprocess, sys, tempfile
from pathlib import Path
import numpy as np
import soundfile as sf

SR = 16000; FENSTER_FRAMES = 16

def lade(pfad: Path) -> np.ndarray:
    if pfad.suffix.lower() != '.wav':
        tmp = Path(tempfile.mkdtemp()) / 'a.wav'
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(pfad), '-ac', '1', '-ar', str(SR), '-sample_fmt', 's16', str(tmp)], check=True)
        pfad = tmp
    a, sr = sf.read(pfad, dtype='float32', always_2d=False)
    if a.ndim > 1: a = a.mean(axis=1)
    if sr != SR:
        import torch, torchaudio
        a = torchaudio.functional.resample(torch.from_numpy(a), sr, SR).numpy()
    return (np.clip(a, -1, 1) * 32767).astype(np.int16)

def main(argv) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--datei', required=True); ap.add_argument('--kopf', default='/data/app-modell/oww-kopf.onnx')
    ap.add_argument('--schwelle', type=float, default=0.95); ap.add_argument('--fenster', type=int, default=3); ap.add_argument('--sperre', type=float, default=2.0)
    a = ap.parse_args(argv)
    from openwakeword.utils import AudioFeatures, download_models
    import onnxruntime as ort
    download_models(model_names=[])
    af = AudioFeatures(inference_framework='onnx')
    pcm = lade(Path(a.datei)); sek = len(pcm) / SR
    # Einbettungen in Stücken von 60 s (Speicher), Frames à 80 ms
    embs = []
    schritt = 60 * SR
    for i in range(0, len(pcm), schritt):
        teil = pcm[i:i + schritt + int(1.3 * SR)]  # Überlappung für Fenster am Rand
        embs.append(np.asarray(af._get_embeddings(teil), dtype=np.float32))
    e = np.concatenate(embs)
    kopf = ort.InferenceSession(a.kopf)
    fenster = np.stack([e[s:s + FENSTER_FRAMES] for s in range(0, e.shape[0] - FENSTER_FRAMES + 1)])
    logit = kopf.run(None, {'emb': fenster})[0]; p = 1 / (1 + np.exp(-logit))
    aus = []; sperre_bis = -1.0; folge = 0
    for i, pi in enumerate(p):
        t = i * 0.08
        if t < sperre_bis: folge = 0; continue
        if pi > a.schwelle:
            folge += 1
            if folge >= a.fenster: aus.append(t); sperre_bis = t + a.sperre; folge = 0
        else: folge = 0
    print(f'{Path(a.datei).name}: {sek / 60:.1f} min, {len(p)} Fenster, Schwelle {a.schwelle}, {a.fenster} Fenster, Sperre {a.sperre} s')
    print(f'AUSLÖSUNGEN: {len(aus)} → {len(aus) / (sek / 3600):.1f} je Stunde')
    print('Zeitpunkte (s):', ' '.join(f'{t:.1f}' for t in aus[:200]))
    print(f'p: Median {np.median(p):.3f}, 99 %-Quantil {np.quantile(p, 0.99):.3f}, Maximum {p.max():.3f}')

if __name__ == '__main__':
    main(sys.argv[1:])
