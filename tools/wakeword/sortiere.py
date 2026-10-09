"""Owner-Aufnahmen (m4a) nach Transkript in /data/echt/{pos,neg} einsortieren und nach WAV 16 kHz mono wandeln.

labels.json: { "Unterthurm_12.m4a": "Alfred." , ... } — Transkripte aus /api/transcribe. Kurze Einzelwörter werden von
der Spracherkennung teils in anderer Schrift geliefert (Альфред, Айфред), deshalb ein breites Muster.
"""
import json, re, subprocess, sys
from pathlib import Path

POS = re.compile(r'alfr[eai]d|alfret|alfrit|eifri|альфред|айфред|альфаид|алфред', re.IGNORECASE)

def main(quelle: str, ziel: str) -> None:
    q = Path(quelle); z = Path(ziel)
    labels = json.loads((q / 'labels.json').read_text(encoding='utf-8'))
    (z / 'pos').mkdir(parents=True, exist_ok=True); (z / 'neg').mkdir(parents=True, exist_ok=True)
    n = {'pos': 0, 'neg': 0, 'fehler': 0}
    for name, text in labels.items():
        src = q / name
        if not src.exists(): continue
        klasse = 'pos' if POS.search(text or '') else 'neg'
        out = z / klasse / (src.stem + '.wav')
        r = subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(src), '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', str(out)], capture_output=True)
        if r.returncode != 0: n['fehler'] += 1; print('ffmpeg', name, r.stderr.decode()[:120], file=sys.stderr); continue
        n[klasse] += 1
    (z / 'labels.json').write_text(json.dumps(labels, ensure_ascii=False, indent=1), encoding='utf-8')
    print('einsortiert:', n)

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '/echt-roh', sys.argv[2] if len(sys.argv) > 2 else '/data/echt')
