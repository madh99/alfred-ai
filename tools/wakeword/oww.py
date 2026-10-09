"""Versuch 3 (10.10.2026): vortrainierte Sprach-Einbettung von openWakeWord (Apache-2.0) statt eigenem CNN von null.

Lauf 1/2 (eigenes CNN auf 3 000 Piper-Clips) lernte die synthetischen Daten, übertrug aber nichts auf die echten
Aufnahmen des Owners (2/64 Treffer). openWakeWord liefert zwei feste ONNX-Modelle (Mel-Spektrogramm + Einbettung, auf
viel echter Sprache trainiert); darauf wird nur ein kleiner Kopf trainiert. Genau dafür empfiehlt openWakeWord
Piper-synthetisierte Clips — also unsere Pipeline.

Eingabe: /data/pos, /data/neg (synth.py), /data/echt/{pos,neg} (Owner-Aufnahmen, Hold-out).
Ausgabe: /data/oww-kopf.onnx (Kopf: Einbettungsfenster → Wahrscheinlichkeit), Messwerte auf stderr/stdout.
"""
import argparse, json, random, sys
from pathlib import Path
import numpy as np
import soundfile as sf
import torch, torch.nn as nn

SR = 16000
FENSTER_FRAMES = 16  # 16 Einbettungs-Frames à 80 ms ≈ 1,3 s (openWakeWord-Standard)

def lade_pcm16(pfad: Path) -> np.ndarray:
    a, sr = sf.read(pfad, dtype='float32', always_2d=False)
    if a.ndim > 1: a = a.mean(axis=1)
    if sr != SR:
        import torchaudio
        a = torchaudio.functional.resample(torch.from_numpy(a), sr, SR).numpy()
    return (np.clip(a, -1, 1) * 32767).astype(np.int16)

def features():
    from openwakeword.utils import AudioFeatures, download_models
    download_models(model_names=[])  # nur die Merkmalsmodelle (melspectrogram, embedding)
    return AudioFeatures(inference_framework='onnx')

def einbetten(af, clips: list[np.ndarray]) -> list[np.ndarray]:
    """Je Clip (int16) die Einbettungen (Frames, 96)."""
    aus = []
    for c in clips:
        # Einzelclip-Pfad: embed_clips mit batch_size=1 bricht in openwakeword 0.6 am squeeze() (Form (144,32) vs (1,145,32))
        e = af._get_embeddings(c)  # (Frames, 96), Fenster 76 Mel-Frames, Schritt 8
        aus.append(np.asarray(e, dtype=np.float32))
    return aus

def fenster_aus(e: np.ndarray, hop: int = 2) -> np.ndarray:
    """Gleitende Fenster über die Frame-Achse → (F, FENSTER_FRAMES, 96); zu kurze Clips vorne mit Nullen auffüllen."""
    if e.shape[0] < FENSTER_FRAMES: e = np.concatenate([np.zeros((FENSTER_FRAMES - e.shape[0], e.shape[1]), np.float32), e])
    starts = list(range(0, e.shape[0] - FENSTER_FRAMES + 1, hop))
    if starts[-1] != e.shape[0] - FENSTER_FRAMES: starts.append(e.shape[0] - FENSTER_FRAMES)
    return np.stack([e[s:s + FENSTER_FRAMES] for s in starts])

class Kopf(nn.Module):
    def __init__(self):
        super().__init__()
        self.f = nn.Sequential(nn.Flatten(), nn.Linear(FENSTER_FRAMES * 96, 64), nn.LayerNorm(64), nn.ReLU(), nn.Dropout(0.3), nn.Linear(64, 1))
    def forward(self, x): return self.f(x).squeeze(1)

def messe(kopf, echt, schwellen=(0.5, 0.7, 0.9)) -> dict:
    kopf.eval(); p = []
    with torch.no_grad():
        for e, _, _ in echt:
            w = torch.from_numpy(fenster_aus(e))
            p.append(float(torch.sigmoid(kopf(w)).max()))
    out = {}
    for s in schwellen:
        tp = sum(1 for (_, l, _), pp in zip(echt, p) if l == 1 and pp > s); P = sum(1 for _, l, _ in echt if l == 1)
        fp = sum(1 for (_, l, _), pp in zip(echt, p) if l == 0 and pp > s); N = sum(1 for _, l, _ in echt if l == 0)
        out[s] = (tp, P, fp, N)
    return out, p

def trainiere(X: torch.Tensor, y: torch.Tensor, epochs: int, lr: float, seed: int = 7) -> Kopf:
    torch.manual_seed(seed)
    kopf = Kopf(); opt = torch.optim.AdamW(kopf.parameters(), lr=lr, weight_decay=1e-3); loss = nn.BCEWithLogitsLoss()
    n = len(X)
    for ep in range(epochs):
        kopf.train(); perm = torch.randperm(n); tot = 0.0
        for i in range(0, n, 64):
            b = perm[i:i + 64]; opt.zero_grad(); l = loss(kopf(X[b]), y[b]); l.backward(); opt.step(); tot += l.item() * len(b)
        if (ep + 1) % 10 == 0 or ep == 0: print(f'Epoche {ep + 1}: Verlust {tot / n:.4f}', file=sys.stderr)
    return kopf

def main(argv) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='/data'); ap.add_argument('--epochs', type=int, default=40); ap.add_argument('--lr', type=float, default=1e-3)
    ap.add_argument('--echt-anteil', type=float, default=0.0, help='Anteil der echten Aufnahmen, der mittrainiert wird (Rest bleibt Hold-out); 0 = alle Hold-out')
    a = ap.parse_args(argv)
    data = Path(a.data); random.seed(7)
    af = features()
    man = json.loads((data / 'manifest.json').read_text())
    print(f'Synthetisch: {len(man)} Clips', file=sys.stderr)
    emb = einbetten(af, [lade_pcm16(data / m['datei']) for m in man])
    # Trainingsfenster: je synthetischem Clip alle Fenster (das Wort liegt an zufälliger Stelle); Label des Clips
    Xs, ys = [], []
    for e, m in zip(emb, man):
        w = fenster_aus(e, hop=4)
        Xs.append(w); ys.append(np.full(len(w), float(m['label']), np.float32))
    X = torch.from_numpy(np.concatenate(Xs)); y = torch.from_numpy(np.concatenate(ys))
    print(f'Trainingsfenster: {len(X)} ({int(y.sum())} positiv), Form {tuple(X.shape[1:])}', file=sys.stderr)
    # echte Aufnahmen
    echt = []
    for label, ordner in ((1, 'pos'), (0, 'neg')):
        d = data / 'echt' / ordner
        if d.exists():
            for p in sorted(d.glob('*.wav')):
                try: echt.append((lade_pcm16(p), label, p.name))
                except Exception as err: print('überspringe', p, err, file=sys.stderr)
    echt_emb = [(e, l, n) for e, (_, l, n) in zip(einbetten(af, [c for c, _, _ in echt]), echt)]
    train_echt, hold = [], echt_emb
    if a.echt_anteil > 0 and echt_emb:
        idx = list(range(len(echt_emb))); random.shuffle(idx); k = int(len(idx) * a.echt_anteil)
        train_echt = [echt_emb[i] for i in idx[:k]]; hold = [echt_emb[i] for i in idx[k:]]
        Xe = np.concatenate([fenster_aus(e, hop=1) for e, _, _ in train_echt]); ye = np.concatenate([np.full(len(fenster_aus(e, hop=1)), float(l), np.float32) for e, l, _ in train_echt])
        # echte Fenster stärker gewichten (wenige, aber die richtige Domäne): 5× wiederholen
        X = torch.cat([X] + [torch.from_numpy(Xe)] * 5); y = torch.cat([y] + [torch.from_numpy(ye)] * 5)
        print(f'Echt mittrainiert: {len(train_echt)} Aufnahmen ({len(Xe)} Fenster ×5), Hold-out {len(hold)}', file=sys.stderr)
    kopf = trainiere(X, y, a.epochs, a.lr)
    # Trainingsgenauigkeit auf Fensterebene
    kopf.eval()
    with torch.no_grad(): acc = ((torch.sigmoid(kopf(X)) > 0.5).float() == y).float().mean().item()
    print(f'Training (Fenster): {acc:.3f}', file=sys.stderr)
    if hold:
        out, p = messe(kopf, hold)
        for s, (tp, P, fp, N) in out.items(): print(f'ECHTE AUFNAHMEN (Hold-out {len(hold)}) Schwelle {s}: Treffer {tp}/{P}, Fehlauslösungen {fp}/{N}')
        for (_, l, name), pp in zip(hold, p): print(f'  {name}: {pp:.2f} ({"Alfred" if l else "nicht"})')
    torch.onnx.export(kopf, torch.zeros(1, FENSTER_FRAMES, 96), str(data / 'oww-kopf.onnx'), input_names=['emb'], output_names=['logit'], dynamic_axes={'emb': {0: 'b'}, 'logit': {0: 'b'}}, opset_version=17, dynamo=False)
    print('exportiert:', data / 'oww-kopf.onnx', (data / 'oww-kopf.onnx').stat().st_size, 'Bytes')

if __name__ == '__main__':
    main(sys.argv[1:])
