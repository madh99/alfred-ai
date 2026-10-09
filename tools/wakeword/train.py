"""Training des Aktivierungswort-Klassifikators und ONNX-Export.

Eingabe: /data/manifest.json + wav-Clips (16 kHz, 1,5 s) aus synth.py; optional /data/echt/{pos,neg}/*.wav (Owner-Aufnahmen),
die als Hold-out gemessen werden (nicht trainiert), solange --echt-mittrainieren nicht gesetzt ist.
Merkmale: Log-Mel (40 Bänder, 25 ms Fenster, 10 ms Schritt) → 40 × 149. Modell: 3 Faltungsblöcke + Mittelung, < 300 KB.
Augmentierung je Epoche: Rauschen, Lautstärke, Zeitversatz, leichter Hall (Exponentialimpuls), Bandbreite.
"""
import argparse, json, random, sys
from pathlib import Path
import numpy as np
import soundfile as sf
import torch, torch.nn as nn, torchaudio

SR = 16000; N = int(1.5 * SR)

class MelFrontend(nn.Module):
    """Log-Mel ohne torch.stft (das lässt sich nicht nach ONNX exportieren): Fensterung + DFT als Conv1d mit festen
    Kosinus/Sinus-Kernen (n_fft 400, Schritt 160), Leistung, Mel-Filterbank als Matrixprodukt, Logarithmus.
    Dieselbe Rechnung im Training und im exportierten Modell — die App liefert nur rohes PCM."""
    def __init__(self, n_fft: int = 400, hop: int = 160, n_mels: int = 40):
        super().__init__()
        n = torch.arange(n_fft, dtype=torch.float32)
        fenster = torch.hann_window(n_fft, periodic=True)
        k = torch.arange(n_fft // 2 + 1, dtype=torch.float32).unsqueeze(1)
        winkel = 2 * torch.pi * k * n.unsqueeze(0) / n_fft
        kern = torch.cat([torch.cos(winkel), -torch.sin(winkel)], dim=0) * fenster  # (2*(n_fft/2+1), n_fft)
        self.register_buffer('kern', kern.unsqueeze(1))  # Conv1d-Gewichte (out, 1, n_fft)
        fb = torchaudio.functional.melscale_fbanks(n_fft // 2 + 1, 0.0, SR / 2, n_mels, SR)  # (n_freqs, n_mels)
        self.register_buffer('fb', fb)
        self.hop = hop; self.bins = n_fft // 2 + 1
    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (B, N) → (B, 1, n_mels, T)
        y = nn.functional.conv1d(x.unsqueeze(1), self.kern, stride=self.hop)  # (B, 2*bins, T)
        re, im = y[:, :self.bins], y[:, self.bins:]
        leistung = re * re + im * im  # (B, bins, T)
        mel = torch.matmul(leistung.transpose(1, 2), self.fb).transpose(1, 2)  # (B, n_mels, T)
        logmel = torch.log(mel + 1e-6)
        # Lauf 09.10.: ohne Normierung hing das Netz an der Lautstärke (Piper vs. Mikrofon) — Mittelwert je Clip abziehen
        # (ONNX-tauglich: ReduceMean), damit nur Form und Verlauf zählen, nicht der Pegel
        logmel = logmel - logmel.mean(dim=(1, 2), keepdim=True)
        return logmel.unsqueeze(1)

MEL = MelFrontend()

def lade(pfad: Path) -> np.ndarray:
    a, sr = sf.read(pfad, dtype='float32', always_2d=False)
    if a.ndim > 1: a = a.mean(axis=1)
    if sr != SR: a = torchaudio.functional.resample(torch.from_numpy(a), sr, SR).numpy()
    if len(a) >= N: a = a[(len(a) - N) // 2:(len(a) - N) // 2 + N]
    else: a = np.pad(a, (0, N - len(a)))
    return a.astype(np.float32)

def merkmale(x: torch.Tensor) -> torch.Tensor:
    """x: (B, N) → (B, 1, 40, T) log-mel (ONNX-tauglicher Frontend, siehe MelFrontend)."""
    return MEL(x)

def augment(x: torch.Tensor) -> torch.Tensor:
    B = x.shape[0]
    g = torch.pow(10.0, torch.empty(B, 1).uniform_(-0.6, 0.3))  # -12 .. +6 dB
    x = x * g
    shift = torch.randint(-int(0.3 * SR), int(0.3 * SR), (1,)).item()
    x = torch.roll(x, shifts=shift, dims=1)
    noise = torch.randn_like(x) * torch.pow(10.0, torch.empty(B, 1).uniform_(-4.0, -2.0))
    x = x + noise
    if random.random() < 0.3:  # Hall
        t = torch.arange(0, int(0.25 * SR)) / SR
        ir = torch.exp(-t / random.uniform(0.03, 0.12)) * torch.randn(len(t)) * 0.05
        ir[0] = 1.0
        x = torchaudio.functional.fftconvolve(x, ir.unsqueeze(0))[:, :N]
    return torch.clamp(x, -1, 1)

class Netz(nn.Module):
    def __init__(self):
        super().__init__()
        def block(i, o): return nn.Sequential(nn.Conv2d(i, o, 3, padding=1), nn.BatchNorm2d(o), nn.ReLU(), nn.MaxPool2d(2))
        self.f = nn.Sequential(block(1, 16), block(16, 32), block(32, 48), nn.AdaptiveAvgPool2d(1), nn.Flatten(), nn.Dropout(0.2), nn.Linear(48, 1))
    def forward(self, x): return self.f(x).squeeze(1)

class Komplett(nn.Module):
    """Für den Export: rohes PCM (B, N) → Wahrscheinlichkeit, damit die App nur Audio liefert."""
    def __init__(self, netz): super().__init__(); self.netz = netz
    def forward(self, pcm): return torch.sigmoid(self.netz(merkmale(pcm)))

def daten(data: Path):
    man = json.loads((data / 'manifest.json').read_text())
    X = np.stack([lade(data / m['datei']) for m in man]); y = np.array([m['label'] for m in man], np.float32)
    return torch.from_numpy(X), torch.from_numpy(y)

def lade_voll(pfad: Path) -> np.ndarray:
    """Ganze Aufnahme (16 kHz, mono), mindestens N Samples — für die Messung mit gleitendem Fenster wie in der App."""
    a, sr = sf.read(pfad, dtype='float32', always_2d=False)
    if a.ndim > 1: a = a.mean(axis=1)
    if sr != SR: a = torchaudio.functional.resample(torch.from_numpy(a), sr, SR).numpy()
    if len(a) < N: a = np.pad(a, (0, N - len(a)))
    return a.astype(np.float32)

def fenster_alle(a: np.ndarray, hop: int = SR // 5) -> np.ndarray:
    """Alle 1,5-s-Fenster einer Aufnahme im 200-ms-Raster (wie der Erkenner in der App) → (F, N)."""
    starts = list(range(0, max(1, len(a) - N + 1), hop))
    if starts[-1] != len(a) - N: starts.append(len(a) - N)
    return np.stack([a[s:s + N] for s in starts])

def echt(data: Path):
    """Owner-Aufnahmen als Hold-out: (ganze Aufnahme, Label, Name). Gemessen wird das Maximum über alle Fenster —
    im Lauf 09.10. nahm `lade` nur die Mitte der Aufnahme, bei längeren Aufnahmen lag das Wort daneben."""
    aus = []
    for label, ordner in ((1, 'pos'), (0, 'neg')):
        d = data / 'echt' / ordner
        if d.exists():
            for p in sorted(d.glob('*')):
                if p.suffix.lower() in ('.wav', '.flac', '.ogg', '.m4a', '.mp3'):
                    try: aus.append((lade_voll(p), label, p.name))
                    except Exception as e: print('überspringe', p, e, file=sys.stderr)
    if aus:
        sek = [len(a) / SR for a, _, _ in aus]
        print(f'Echte Aufnahmen: {len(aus)}, Länge {min(sek):.1f}–{max(sek):.1f} s (Median {float(np.median(sek)):.1f} s)', file=sys.stderr)
    return aus

def main(argv) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='/data'); ap.add_argument('--epochs', type=int, default=20); ap.add_argument('--echt-mittrainieren', action='store_true')
    ap.add_argument('--ohne-augment', action='store_true', help='Lernkontrolle: ohne Augmentierung muss das Netz die synthetischen Daten sicher lernen')
    ap.add_argument('--lr', type=float, default=1e-3)
    a = ap.parse_args(argv)
    data = Path(a.data); torch.manual_seed(7); random.seed(7)
    X, y = daten(data)
    e = echt(data)
    if a.echt_mittrainieren and e:
        mitte = lambda c: c[(len(c) - N) // 2:(len(c) - N) // 2 + N]
        X = torch.cat([X, torch.from_numpy(np.stack([mitte(c) for c, _, _ in e]))]); y = torch.cat([y, torch.tensor([l for _, l, _ in e], dtype=torch.float32)])
    idx = torch.randperm(len(X)); n_val = max(50, len(X) // 10)
    val, tr = idx[:n_val], idx[n_val:]
    netz = Netz(); opt = torch.optim.AdamW(netz.parameters(), lr=a.lr, weight_decay=1e-4); loss = nn.BCEWithLogitsLoss()
    print(f'Daten: {len(tr)} Training, {len(val)} Hold-out, {int(y.sum())} positiv, Augmentierung {"aus" if a.ohne_augment else "an"}', file=sys.stderr)
    for ep in range(a.epochs):
        netz.train(); perm = tr[torch.randperm(len(tr))]; tot = 0.0; richtig = 0
        for i in range(0, len(perm), 64):
            b = perm[i:i + 64]; xb = X[b] if a.ohne_augment else augment(X[b]); opt.zero_grad()
            out = netz(merkmale(xb)); l = loss(out, y[b]); l.backward(); opt.step(); tot += l.item() * len(b)
            richtig += ((out > 0).float() == y[b]).float().sum().item()
        netz.eval()
        with torch.no_grad():
            p = torch.sigmoid(netz(merkmale(X[val]))); acc = ((p > 0.5).float() == y[val]).float().mean().item()
        print(f'Epoche {ep + 1}: Verlust {tot / len(tr):.4f}, Training {richtig / len(tr):.3f}, Hold-out (synthetisch) {acc:.3f}', file=sys.stderr)
    torch.save(netz.state_dict(), data / 'alfred.pt')
    komplett = Komplett(netz).eval()
    torch.onnx.export(komplett, torch.zeros(1, N), str(data / 'alfred.onnx'), input_names=['pcm'], output_names=['p'], dynamic_axes={'pcm': {0: 'b'}, 'p': {0: 'b'}}, opset_version=17, dynamo=False)
    # Gegenprobe: ONNX und Torch müssen dasselbe liefern
    import onnxruntime as ort
    s = ort.InferenceSession(str(data / 'alfred.onnx')); probe = X[:4]
    with torch.no_grad(): a = komplett(probe).numpy()
    b = s.run(None, {'pcm': probe.numpy()})[0]
    print('ONNX-Gegenprobe max. Abweichung:', float(np.abs(a - b).max()))
    print('exportiert:', data / 'alfred.onnx', (data / 'alfred.onnx').stat().st_size, 'Bytes')
    if e: messe(komplett, e)

def messe(modell, e, schwelle: float = 0.5) -> None:
    """Je Aufnahme das Maximum über alle 1,5-s-Fenster (200-ms-Raster) — so arbeitet der Erkenner in der App."""
    p = []
    with torch.no_grad():
        for c, _, _ in e:
            p.append(float(modell(torch.from_numpy(fenster_alle(c))).numpy().max()))
    tp = sum(1 for (_, l, _), pp in zip(e, p) if l == 1 and pp > schwelle); P = sum(1 for _, l, _ in e if l == 1)
    fp = sum(1 for (_, l, _), pp in zip(e, p) if l == 0 and pp > schwelle); Nn = sum(1 for _, l, _ in e if l == 0)
    print(f'ECHTE AUFNAHMEN: Treffer {tp}/{P}, Fehlauslösungen {fp}/{Nn} (Schwelle {schwelle}, Maximum über Fenster)')
    for s in (0.7, 0.9):
        tp2 = sum(1 for (_, l, _), pp in zip(e, p) if l == 1 and pp > s); fp2 = sum(1 for (_, l, _), pp in zip(e, p) if l == 0 and pp > s)
        print(f'  Schwelle {s}: Treffer {tp2}/{P}, Fehlauslösungen {fp2}/{Nn}')
    for (_, l, name), pp in zip(e, p): print(f'  {name}: {pp:.2f} ({"Alfred" if l else "nicht"})')

def evaluate_cli(argv) -> None:
    ap = argparse.ArgumentParser(); ap.add_argument('--model', default='/data/alfred.onnx'); ap.add_argument('--dir', default='/data')
    a = ap.parse_args(argv)
    import onnxruntime as ort
    s = ort.InferenceSession(a.model)
    e = echt(Path(a.dir))
    if not e: print('keine echten Aufnahmen unter', Path(a.dir) / 'echt'); return
    class Onnx:  # wie messe(): Maximum über alle Fenster, Modell = ONNX-Laufzeit
        def __call__(self, X): return torch.from_numpy(s.run(None, {'pcm': X.numpy()})[0])
    messe(Onnx(), e)

if __name__ == '__main__':
    main(sys.argv[1:])
