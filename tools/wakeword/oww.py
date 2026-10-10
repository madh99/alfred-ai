"""Versuch 3/4 (10.10.2026): vortrainierte Sprach-Einbettung von openWakeWord (Apache-2.0) statt eigenem CNN von null.

Lauf 1/2 (eigenes CNN auf 3 000 Piper-Clips) lernte die synthetischen Daten, übertrug aber nichts auf die echten
Aufnahmen des Owners (2/64 Treffer). openWakeWord liefert zwei feste ONNX-Modelle (Mel-Spektrogramm + Einbettung, auf
viel echter Sprache trainiert); darauf wird nur ein kleiner Kopf trainiert. Genau dafür empfiehlt openWakeWord
Piper-synthetisierte Clips — also unsere Pipeline.

Lauf 3 (ohne Augmentierung, nur ein Fenster je Clip): 43/64 Treffer, 27/103 Fehlauslösungen auf allen echten Aufnahmen.
Befund: (a) lange gesprochene Sätze lösen aus (im Training gab es keine langen Negative), (b) ein Teil der „Negative"
sind laut Transkript wahrscheinlich undeutlich gesprochene „Alfred" („Айфрит", „I've fled", „Eifrits") — Beschriftung
unsicher, (c) Pegel/Raum des Mikrofons fehlen in den Daten.
Lauf 4 deshalb: Augmentierung (Pegel, Rauschen, Hall) vor der Einbettung, zusammengesetzte lange Negative und Positive
im Sprachkontext aus den vorhandenen Clips, unsichere Beschriftungen aus der Messung herausgehalten (eigene Liste),
Messung zusätzlich mit der App-Regel „zwei aufeinanderfolgende Fenster", 5-fache Kreuzvalidierung, wenn echte
Aufnahmen mittrainiert werden.

Eingabe: /data/pos, /data/neg (synth.py), /data/echt/{pos,neg} + /data/echt/labels.json (Owner-Aufnahmen, Hold-out).
Ausgabe: /data/oww-kopf.onnx (Kopf: Einbettungsfenster → Logit), Messwerte auf stderr/stdout.
"""
import argparse, json, random, re, sys
from pathlib import Path
import numpy as np
import soundfile as sf
import torch, torch.nn as nn

SR = 16000
FENSTER_FRAMES = 16  # 16 Einbettungs-Frames à 80 ms ≈ 1,3 s (openWakeWord-Standard)
UNSICHER = re.compile(r'альф|айф|афр|alf|eifr|fled|ei.?fr|альц|afr|elfr|olfr', re.I)
KLAR_POSITIV = re.compile(r'^(alfred|альфред|айфред)[.!?,]*$', re.I)

def lade_f32(pfad: Path) -> np.ndarray:
    a, sr = sf.read(pfad, dtype='float32', always_2d=False)
    if a.ndim > 1: a = a.mean(axis=1)
    if sr != SR:
        import torchaudio
        a = torchaudio.functional.resample(torch.from_numpy(a), sr, SR).numpy()
    return np.clip(a, -1, 1).astype(np.float32)

def zu_int16(a: np.ndarray) -> np.ndarray: return (np.clip(a, -1, 1) * 32767).astype(np.int16)

def augmentiere(a: np.ndarray, rng: random.Random) -> np.ndarray:
    """Pegel −12…+6 dB, weißes/rosa Rauschen, kurzer Hall, leichte Tiefpass-Färbung — grob wie ein Zimmer-Mikrofon."""
    x = a * (10 ** rng.uniform(-0.6, 0.3))
    if rng.random() < 0.8:
        n = np.random.randn(len(x)).astype(np.float32)
        if rng.random() < 0.5:  # rosa: Tiefpass über laufenden Mittelwert
            k = 8; n = np.convolve(n, np.ones(k, np.float32) / k, mode='same')
        x = x + n * (10 ** rng.uniform(-3.5, -1.8))
    if rng.random() < 0.4:  # Hall: exponentiell abfallende Impulsantwort
        t = np.arange(int(0.25 * SR)) / SR
        ir = (np.exp(-t / rng.uniform(0.03, 0.15)) * np.random.randn(len(t)) * 0.05).astype(np.float32); ir[0] = 1.0
        x = np.convolve(x, ir, mode='full')[:len(a)]
    if rng.random() < 0.3:  # dumpfer (Abstand): gleitender Mittelwert über 3 Samples
        x = np.convolve(x, np.ones(3, np.float32) / 3, mode='same')
    return np.clip(x, -1, 1).astype(np.float32)

def features():
    from openwakeword.utils import AudioFeatures, download_models
    download_models(model_names=[])  # nur die Merkmalsmodelle (melspectrogram, embedding)
    return AudioFeatures(inference_framework='onnx')

def einbetten(af, clips: list[np.ndarray]) -> list[np.ndarray]:
    """Je Clip (float32 −1…1) die Einbettungen (Frames, 96). Einzelclip-Pfad (embed_clips bricht bei batch_size 1)."""
    # Lauf 6: letzte Stücke langer Aufnahmen können < 1,5 s sein → auf 1,5 s auffüllen (sonst „Invalid rank for input" in der Einbettung)
    mind = int(1.5 * SR)
    return [np.asarray(af._get_embeddings(zu_int16(np.pad(c, (0, max(0, mind - len(c)))))), dtype=np.float32) for c in clips]

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

def bewerte(kopf, e: np.ndarray) -> tuple[float, float, float]:
    """(Maximum über Fenster, App-Regel 2 Fenster: Minimum zweier aufeinanderfolgender, App-Regel 3 Fenster)."""
    with torch.no_grad():
        p = torch.sigmoid(kopf(torch.from_numpy(fenster_aus(e, hop=1)))).numpy()
    zwei = max((min(p[i], p[i + 1]) for i in range(len(p) - 1)), default=float(p.max()))
    drei = max((min(p[i], p[i + 1], p[i + 2]) for i in range(len(p) - 2)), default=float(zwei))
    return float(p.max()), float(zwei), float(drei)

def ist_lang_stueck(name: str) -> bool: return bool(re.match(r'^Negativ_\d+_\d{3}\.wav$', name))  # nur Stücke langer Negativaufnahmen (neu-sortiere.py), nicht „Negativ_172"/„Unterthurm_100"

def messe(kopf, echt, titel: str) -> None:
    kopf.eval()
    w = [(bewerte(kopf, e), l, n) for e, l, n in echt]
    P = sum(1 for _, l, _ in echt if l == 1); N = len(echt) - P
    lang = [x for x in w if x[1] == 0 and ist_lang_stueck(x[2])]; minuten = len(lang) * 3 / 60
    for s in (0.5, 0.7, 0.9, 0.95):
        tp = sum(1 for (pm, _, _), l, _ in w if l == 1 and pm > s); fp = sum(1 for (pm, _, _), l, _ in w if l == 0 and pm > s)
        tp2 = sum(1 for (_, pz, _), l, _ in w if l == 1 and pz > s); fp2 = sum(1 for (_, pz, _), l, _ in w if l == 0 and pz > s)
        tp3 = sum(1 for (_, _, pd), l, _ in w if l == 1 and pd > s); fp3 = sum(1 for (_, _, pd), l, _ in w if l == 0 and pd > s)
        fa2 = sum(1 for (_, pz, _), _, _ in lang if pz > s); fa3 = sum(1 for (_, _, pd), _, _ in lang if pd > s)
        dauer = f' | Dauerton {minuten:.1f} min: {fa2 / minuten * 60:.0f}/h (2 F.), {fa3 / minuten * 60:.0f}/h (3 F.)' if minuten > 0 else ''
        print(f'ECHTE AUFNAHMEN {titel} Schwelle {s}: Treffer {tp}/{P}, Fehlauslösungen {fp}/{N} | 2 Fenster: {tp2}/{P}, {fp2}/{N} | 3 Fenster: {tp3}/{P}, {fp3}/{N}{dauer}')
    for (pm, pz, pd), l, n in w: print(f'  {n}: {pm:.2f}/{pz:.2f}/{pd:.2f} ({"Alfred" if l else "nicht"})')

Teil = tuple[torch.Tensor, torch.Tensor, torch.Tensor]  # (X float16 [n,16,96], y [n], Gewicht [n])

def trainiere(teile: list[Teil], epochs: int, lr: float, seed: int = 7, still=False) -> Kopf:
    """Lauf 6: ohne Kopieren der Daten (OOM bei 4 GB auf der .96) — Teile bleiben getrennt, Stichprobe über einen gemeinsamen
    Indexraum, Gewichte je Fenster statt Vervielfachung, Speicherung float16, Umwandlung je Batch."""
    torch.manual_seed(seed)
    kopf = Kopf(); opt = torch.optim.AdamW(kopf.parameters(), lr=lr, weight_decay=1e-3); loss = nn.BCEWithLogitsLoss(reduction='none')
    laengen = [len(t[0]) for t in teile]; n = sum(laengen); grenzen = np.cumsum([0] + laengen)
    def hole(idx: torch.Tensor):
        xs, ys, ws = [], [], []
        for k, (X, y, w) in enumerate(teile):
            m = (idx >= grenzen[k]) & (idx < grenzen[k + 1])
            if m.any(): j = idx[m] - grenzen[k]; xs.append(X[j].float()); ys.append(y[j]); ws.append(w[j])
        return torch.cat(xs), torch.cat(ys), torch.cat(ws)
    for ep in range(epochs):
        kopf.train(); perm = torch.randperm(n); tot = 0.0
        for i in range(0, n, 128):
            xb, yb, wb = hole(perm[i:i + 128]); opt.zero_grad(); l = (loss(kopf(xb), yb) * wb).sum() / wb.sum(); l.backward(); opt.step(); tot += l.item() * len(yb)
        if not still and ((ep + 1) % 10 == 0 or ep == 0): print(f'Epoche {ep + 1}: Verlust {tot / n:.4f}', file=sys.stderr)
    return kopf

def genauigkeit(kopf: Kopf, teile: list[Teil]) -> float:
    kopf.eval(); richtig = 0; n = 0
    with torch.no_grad():
        for X, y, _ in teile:
            for i in range(0, len(X), 1024):
                p = torch.sigmoid(kopf(X[i:i + 1024].float())); richtig += ((p > 0.5).float() == y[i:i + 1024]).sum().item(); n += len(p)
    return richtig / max(1, n)

def synthetische_trainingsdaten(af, data: Path, kopien: int, rng: random.Random):
    man = json.loads((data / 'manifest.json').read_text())
    pos = [lade_f32(data / m['datei']) for m in man if m['label'] == 1]
    neg = [lade_f32(data / m['datei']) for m in man if m['label'] == 0]
    print(f'Synthetisch: {len(pos)} positiv, {len(neg)} negativ; Augmentierung ×{kopien}', file=sys.stderr)
    Xs, ys = [], []
    def nimm(c: np.ndarray, l: int) -> None:
        # Lauf 6: sofort einbetten und das PCM verwerfen (OOM auf der .96 mit allen Clips im Speicher)
        e = einbetten(af, [c])[0]
        if l == 1 and e.shape[0] > FENSTER_FRAMES + 4:
            w = fenster_aus(e, hop=2); m = len(w) // 2; w = w[max(0, m - 3):m + 4]  # langes Positiv: nur die Mitte (dort liegt das Wort)
        else:
            w = fenster_aus(e, hop=2)
        Xs.append(w.astype(np.float16)); ys.append(np.full(len(w), float(l), np.float32))
    for _ in range(kopien):
        for c in pos: nimm(augmentiere(c, rng), 1)
        for c in neg: nimm(augmentiere(c, rng), 0)
    # zusammengesetzte lange Negative (2–3 Negative hintereinander, bis 4 s): lange Sätze lösten in Lauf 3 aus
    for _ in range(len(neg)):
        teile = [rng.choice(neg) for _ in range(rng.randint(2, 3))]
        nimm(augmentiere(np.concatenate(teile)[:4 * SR], rng), 0)
    # Positive im Sprachkontext (Negativ + Alfred + Negativ): das Wort mitten im Reden
    for _ in range(len(pos) // 2):
        p = rng.choice(pos); a = rng.choice(neg); b = rng.choice(neg)
        nimm(augmentiere(np.concatenate([a, p, b])[:4 * SR], rng), 1)
    # Lauf 5: lange synthetische Negative (fließende Sätze, /data/neg_lang, synth --lang) — in voller Länge, einmal augmentiert
    lang = sorted((data / 'neg_lang').glob('*.wav')) if (data / 'neg_lang').exists() else []
    if lang:
        sek = 0.0
        for p in lang:
            c = lade_f32(p); sek += len(c) / SR
            nimm(augmentiere(c, rng), 0)
        print(f'Lange synthetische Negative: {len(lang)} Clips, {sek / 60:.1f} min', file=sys.stderr)
    X = torch.from_numpy(np.concatenate(Xs)); y = torch.from_numpy(np.concatenate(ys))
    return (X, y, torch.ones(len(y)))

def echte_aufnahmen(af, data: Path):
    labels = {}
    try:
        for k, v in json.loads((data / 'echt' / 'labels.json').read_text()).items(): labels[re.sub(r'\.m4a$', '', k, flags=re.I)] = v
    except Exception: pass
    klar, unsicher = [], []
    for label, ordner in ((1, 'pos'), (0, 'neg')):
        d = data / 'echt' / ordner
        if not d.exists(): continue
        for p in sorted(d.glob('*.wav')):
            try: c = lade_f32(p)
            except Exception as err: print('überspringe', p, err, file=sys.stderr); continue
            t = labels.get(p.stem, '').strip()
            if (not t) or (UNSICHER.search(t) and not KLAR_POSITIV.match(t)): unsicher.append((c, label, f'{p.name} „{t}"'))
            else: klar.append((c, label, p.name))
    print(f'Echte Aufnahmen: {len(klar)} klar beschriftet, {len(unsicher)} unsicher (aus der Messung herausgehalten)', file=sys.stderr)
    for _, l, n in unsicher: print(f'  unsicher: {n} (bisher {"Alfred" if l else "nicht"})', file=sys.stderr)
    e1 = einbetten(af, [c for c, _, _ in klar]); e2 = einbetten(af, [c for c, _, _ in unsicher])
    return [(e, l, n) for e, (_, l, n) in zip(e1, klar)], [(e, l, n) for e, (_, l, n) in zip(e2, unsicher)]

def echt_fenster(aufn, lang_gewicht: float = 3.0, grundgewicht: float = 5.0) -> Teil:
    """Fenster der echten Aufnahmen als Teil (X float16, y, Gewicht): echte Fenster zählen grundgewicht-fach (wenige, richtige Domäne),
    Stücke aus langen Negativaufnahmen (Dauerton) zusätzlich lang_gewicht-fach (Lauf 5: 39 Fehlauslösungen/h in Lauf 4) — ohne Kopien."""
    Xs, ys, ws = [], [], []
    for e, l, n in aufn:
        w = fenster_aus(e, hop=1); g = grundgewicht * (lang_gewicht if (l == 0 and ist_lang_stueck(n)) else 1.0)
        Xs.append(w.astype(np.float16)); ys.append(np.full(len(w), float(l), np.float32)); ws.append(np.full(len(w), g, np.float32))
    return (torch.from_numpy(np.concatenate(Xs)), torch.from_numpy(np.concatenate(ys)), torch.from_numpy(np.concatenate(ws)))

def main(argv) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='/data'); ap.add_argument('--epochs', type=int, default=40); ap.add_argument('--lr', type=float, default=1e-3)
    ap.add_argument('--kopien', type=int, default=3, help='augmentierte Kopien je synthetischem Clip')
    ap.add_argument('--echt-mittrainieren', action='store_true', help='echte Aufnahmen mittrainieren: 5-fache Kreuzvalidierung zur Messung, dann Kopf auf allen Daten')
    ap.add_argument('--echt-gewicht', type=float, default=5.0)
    a = ap.parse_args(argv)
    data = Path(a.data); rng = random.Random(7); np.random.seed(7)
    af = features()
    syn = synthetische_trainingsdaten(af, data, a.kopien, rng)
    print(f'Trainingsfenster synthetisch: {len(syn[0])} ({int(syn[1].sum())} positiv)', file=sys.stderr)
    klar, unsicher = echte_aufnahmen(af, data)
    if not a.echt_mittrainieren or not klar:
        kopf = trainiere([syn], a.epochs, a.lr)
        print(f'Training (Fenster): {genauigkeit(kopf, [syn]):.3f}', file=sys.stderr)
        if klar: messe(kopf, klar, f'(Hold-out {len(klar)} klar)')
        if unsicher: messe(kopf, unsicher, f'(unsicher beschriftet {len(unsicher)})')
    else:
        idx = list(range(len(klar))); rng.shuffle(idx); k = 5
        falten = [idx[i::k] for i in range(k)]
        gesamt = []
        for f in range(k):
            test_idx = set(falten[f])
            test = [klar[i] for i in falten[f]]; train = [klar[i] for i in idx if i not in test_idx]
            kopf = trainiere([syn, echt_fenster(train, grundgewicht=a.echt_gewicht)], a.epochs, a.lr, seed=7 + f, still=True)
            kopf.eval(); gesamt += [(bewerte(kopf, e), l, n) for e, l, n in test]
            print(f'Falte {f + 1}/{k} fertig', file=sys.stderr)
        P = sum(1 for _, l, _ in gesamt if l == 1); N = len(gesamt) - P
        lang = [x for x in gesamt if x[1] == 0 and ist_lang_stueck(x[2])]; minuten = len(lang) * 3 / 60
        for s in (0.5, 0.7, 0.9, 0.95):
            tp = sum(1 for (pm, _, _), l, _ in gesamt if l == 1 and pm > s); fp = sum(1 for (pm, _, _), l, _ in gesamt if l == 0 and pm > s)
            tp2 = sum(1 for (_, pz, _), l, _ in gesamt if l == 1 and pz > s); fp2 = sum(1 for (_, pz, _), l, _ in gesamt if l == 0 and pz > s)
            tp3 = sum(1 for (_, _, pd), l, _ in gesamt if l == 1 and pd > s); fp3 = sum(1 for (_, _, pd), l, _ in gesamt if l == 0 and pd > s)
            fa2 = sum(1 for (_, pz, _), _, _ in lang if pz > s); fa3 = sum(1 for (_, _, pd), _, _ in lang if pd > s)
            dauer = f' | Dauerton {minuten:.1f} min: {fa2 / minuten * 60:.0f}/h (2 F.), {fa3 / minuten * 60:.0f}/h (3 F.)' if minuten > 0 else ''
            print(f'ECHTE AUFNAHMEN (5-fach kreuzvalidiert, {len(gesamt)}) Schwelle {s}: Treffer {tp}/{P}, Fehlauslösungen {fp}/{N} | 2 Fenster: {tp2}/{P}, {fp2}/{N} | 3 Fenster: {tp3}/{P}, {fp3}/{N}{dauer}')
        for (pm, pz, pd), l, n in sorted(gesamt, key=lambda t: t[2]): print(f'  {n}: {pm:.2f}/{pz:.2f}/{pd:.2f} ({"Alfred" if l else "nicht"})')
        kopf = trainiere([syn, echt_fenster(klar, grundgewicht=a.echt_gewicht)], a.epochs, a.lr)
        if unsicher: messe(kopf, unsicher, f'(unsicher beschriftet {len(unsicher)}, Kopf auf allen klaren trainiert)')
    kopf.eval()
    torch.onnx.export(kopf, torch.zeros(1, FENSTER_FRAMES, 96), str(data / 'oww-kopf.onnx'), input_names=['emb'], output_names=['logit'], dynamic_axes={'emb': {0: 'b'}, 'logit': {0: 'b'}}, opset_version=17, dynamo=False)
    print('exportiert:', data / 'oww-kopf.onnx', (data / 'oww-kopf.onnx').stat().st_size, 'Bytes')

if __name__ == '__main__':
    main(sys.argv[1:])
