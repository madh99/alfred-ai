"""Einstieg: `synth` erzeugt Trainingsdaten, `train` trainiert und exportiert ONNX, `eval` misst auf echten Aufnahmen."""
import sys

def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'help'
    if cmd == 'synth':
        from synth import main as m; m(sys.argv[2:])
    elif cmd == 'train':
        from train import main as m; m(sys.argv[2:])
    elif cmd == 'eval':
        from train import evaluate_cli as m; m(sys.argv[2:])
    elif cmd == 'oww':
        from oww import main as m; m(sys.argv[2:])
    else:
        print('Befehle: synth [--out /data] [--n 1500] | train [--data /data] [--epochs 20] | eval [--model /data/alfred.onnx] [--dir /data/echt] | oww [--epochs 40] [--echt-anteil 0.5]')

if __name__ == '__main__':
    main()
