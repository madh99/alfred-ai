import 'package:flutter_test/flutter_test.dart';
import 'package:alfred_app/antwort_aktionen.dart';
import 'package:alfred_app/modell.dart';

/// 1.50.0 (v1510, D6a/D6b) — Klartext, Frage zur Antwort, Aufgabentitel, Stufen-Infos.
void main() {
  test('Klartext aus Markdown: Fett, Kursiv, Code, Überschrift, Links, Listen, Zäune', () {
    const md = '## Ergebnis\n\n**647,35 €** von *Jänner* bis `September`.\n\n- [HeizOel24](https://heizoel24.at)\n- https://x.at\n\n```\nnpm test\n```\n---\n> Zitat';
    expect(ohneMarkdown(md), 'Ergebnis\n\n647,35 € von Jänner bis September.\n\n• HeizOel24 (https://heizoel24.at)\n• https://x.at\n\nnpm test\n\nZitat');
    expect(ohneMarkdown('5 * 3 = 15 und a*b'), '5 * 3 = 15 und a*b');
  });

  test('Frage vor einer Antwort; Upload-Zeilen werden zu „📎 Name“', () {
    final v = [
      Eintrag(Art.du, 'Wie viel Strom heuer?'),
      Eintrag(Art.alfred, '647 €'),
      Eintrag(Art.hinweis, 'x'),
      Eintrag(Art.du, 'Datei „a.png" (1 Bytes) liegt in deinem Dateispeicher, Schlüssel: k/a.png.\nBestätige kurz den Empfang.'),
      Eintrag(Art.alfred, 'Ein Bild.'),
    ];
    expect(frageVor(v, 1), 'Wie viel Strom heuer?');
    expect(frageVor(v, 4), '📎 a.png');
    expect(frageVor(v, 0), '');
  });

  test('Aufgabentitel: erste Textzeile ohne Markdown, gekürzt', () {
    expect(aufgabenTitel('## Heizöl bestellen\nbei Kreuzmayr'), 'Heizöl bestellen');
    expect(aufgabenTitel('- **Zähler ablesen**'), 'Zähler ablesen');
    expect(aufgabenTitel('x' * 200).length, 120);
  });

  test('Stufen: Automatisch zeigt die Stufe default, Zuletzt aus der Antwort, Gründlichkeit deutsch', () {
    final s = StufenStand.aus({
      'stufen': [
        {'stufe': 'default', 'modell': 'gpt-6.1-sol', 'gruendlichkeit': 'medium', 'verfuegbar': true},
        {'stufe': 'strong', 'modell': 'claude-opus-5-5', 'gruendlichkeit': 'high', 'verfuegbar': true},
        {'stufe': 'fast', 'modell': 'claude-sonnet-5-5', 'gruendlichkeit': 'low', 'verfuegbar': false},
      ],
      'automatisch': 'default',
      'zuletzt': {'modell': 'claude-opus-5-5', 'stufe': 'strong', 'zeit': 1792410000000},
    });
    expect(s.fuer(null)?.modell, 'gpt-6.1-sol');
    expect(s.fuer('strong')?.modell, 'claude-opus-5-5');
    expect(stufeZeile(s.fuer(null)), 'gpt-6.1-sol · Gründlichkeit mittel');
    expect(stufeZeile(s.fuer('fast')), 'claude-sonnet-5-5 · Gründlichkeit gering · nicht verfügbar');
    expect(s.zuletztModell, 'claude-opus-5-5');
    expect(stufeZeile(null), '');
  });
}
