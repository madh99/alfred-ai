import 'package:flutter_test/flutter_test.dart';
import 'package:alfred_app/befunde.dart';

// 1.12.0 — Ansicht „Befunde": Haus-Check zuletzt und nach Regel gruppiert, „neu" = 7 Tage
Befund b(String id, String quelle, {String? regel, String entstanden = '2026-10-12T00:00:00Z'}) =>
    Befund({'id': id, 'quelle': quelle, 'regel': regel, 'titel': 't$id', 'entstanden': entstanden, 'anzahl': 2});

void main() {
  test('Quellen: übrige alphabetisch nach Anzeigename, Haus-Check zuletzt', () {
    final l = [b('1', 'haus-check', regel: 'B1'), b('2', 'infra'), b('3', 'energie'), b('4', 'haus-check', regel: 'A1')];
    expect(quellenReihenfolge(l), ['energie', 'infra', 'haus-check']);
  });

  test('Gruppen nach Regel A1 … B3; ohne Regel eine Gruppe', () {
    final g = befundGruppen([b('1', 'haus-check', regel: 'B2'), b('2', 'haus-check', regel: 'A1'), b('3', 'haus-check', regel: 'B2')]);
    expect(g.map((e) => '${e.key}:${e.value.length}').toList(), ['A1:1', 'B2:2']);
    expect(befundGruppen([b('5', 'infra')]).single.key, isNull);
    expect(regelName('B3'), 'Verbindung instabil');
    expect(befundQuelle('haus-check'), 'Haus-Check');
  });

  test('neu: in den letzten 7 Tagen entstanden', () {
    final jetzt = DateTime.parse('2026-10-12T12:00:00Z');
    expect(befundNeu(b('1', 'x', entstanden: '2026-10-10T00:00:00Z'), jetzt), isTrue);
    expect(befundNeu(b('2', 'x', entstanden: '2026-10-01T00:00:00Z'), jetzt), isFalse);
  });
}
