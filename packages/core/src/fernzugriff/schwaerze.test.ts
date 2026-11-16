import { describe, it, expect } from 'vitest';
import { schwaerze, GEHEIM_NAME } from './kaefig.js';

// Alle Werte sind offensichtliche Platzhalter — keine echten Geheimnisse.
const weg = (eingabe: string, geheim: string[], bleibt: string[] = []) => {
  const r = schwaerze(eingabe);
  for (const g of geheim) expect(r.text, `${eingabe} → ${g}`).not.toContain(g);
  for (const b of bleibt) expect(r.text, `${eingabe} → ${b}`).toContain(b);
  expect(r.anzahl, eingabe).toBeGreaterThanOrEqual(geheim.length > 0 ? 1 : 0);
  return r;
};

describe('Schwärzung — bisherige Fälle bleiben geschwärzt (Regression)', () => {
  it('privater Schlüssel', () => {
    const r = weg('-----BEGIN RSA PRIVATE KEY-----\nTUlJRHVtbXlEdW1teQ==\n-----END RSA PRIVATE KEY-----', ['TUlJRHVtbXlEdW1teQ==']);
    expect(r.anzahl).toBe(1);
  });
  it('Passwort-Hash', () => { expect(weg('admin:$apr1$dummysalt$abcdefghijklmnop', ['$apr1$dummysalt']).anzahl).toBe(1); });
  it('export KEY=Wert am Zeilenanfang (auch mit Komma im Wert)', () => {
    const r = weg('export DB_PASSWORD=platzhalter,teil2', ['platzhalter', 'teil2'], ['DB_PASSWORD=']);
    expect(r.anzahl).toBe(1);
  });
  it('export KEY="Wert" zählt genau einmal', () => { expect(weg('export API_KEY="dummy1234abcd"', ['dummy1234abcd']).anzahl).toBe(1); });
  it('URL-Zugangsdaten', () => { expect(weg('postgres://app:dummypass@db:5432/app', ['dummypass'], ['@db:5432']).anzahl).toBe(1); });
  it('Bearer', () => { expect(weg('Authorization: Bearer dummyTokenAbcdefgh123456', ['dummyTokenAbcdefgh123456']).anzahl).toBe(1); });
});

describe('Schwärzung — neue Fälle', () => {
  it('1: KEY=Wert mitten in der Zeile (Verbindungszeichenfolge)', () => {
    const r = weg('Server=sql01;User Id=sa;Password=Dummy123;Encrypt=True', ['Dummy123'], ['Server=sql01', 'Encrypt=True', 'User Id=sa']);
    expect(r.anzahl).toBe(1);
  });
  it('1: nach weiteren Trennzeichen', () => {
    for (const [e, g] of [['a=1, secret=Dummy123x', 'Dummy123x'], ['f(token: Dummy123y)', 'Dummy123y'], ["x 'passwd'='Dummy123z'", 'Dummy123z'], ['{api_key=Dummy123w}', 'Dummy123w']] as const) weg(e, [g]);
  });
  it('2: Wert mit Leerzeichen in Anführungszeichen', () => {
    weg('Password="Mein Dummy Wort"', ['Mein', 'Dummy Wort']);
    weg("conn: password='Mein Dummy Wort' host=x", ['Mein', 'Dummy Wort'], ['host=x']);
  });
  it('nicht-geheimer Schlüssel verschluckt keinen geheimen dahinter', () => {
    weg('conn: password=Dummy123', ['Dummy123'], ['conn: password=']);
    weg('cmd -v x=1 --token abcd1234', ['abcd1234'], ['-v x=1']);
  });
  it('grep-Ausgabe datei:key=wert', () => {
    weg('/opt/app/.env:DB_PASSWORD=Dummy123', ['Dummy123'], ['/opt/app/.env:DB_PASSWORD=']);
    weg('config.yml:12:  secret: Dummy123', ['Dummy123']);
  });
  it('3: JSON in Textausgaben', () => {
    const r = weg('{"password": "Dummy123", "user": "sa"}', ['Dummy123'], ['"user": "sa"']);
    expect(r.anzahl).toBe(1);
  });
  it('4: Kommandozeilen-Argumente', () => {
    weg('mytool --password Dummy123 --host x', ['Dummy123'], ['--host x']);
    weg('mytool --password=Dummy123', ['Dummy123']);
    weg('cli --token abcdef123456', ['abcdef123456']);
    weg('New-Thing -Password Dummy123 -Name x', ['Dummy123'], ['-Name x']);
    weg('sshpass -p Dummy123 ssh root@host', ['Dummy123'], ['ssh root@host']);
    weg('mysql -u root -pDummy123 db', ['Dummy123'], ['-u root']);
    weg('mytool --password "Mein Dummy" -v', ['Mein', 'Dummy"']);
  });
  it('5: Authorization Basic', () => {
    weg('Authorization: Basic ZHVtbXk6ZHVtbXk=', ['ZHVtbXk6ZHVtbXk=']);
    weg('Proxy-Authorization: basic ZHVtbXk6ZHVtbXk=', ['ZHVtbXk6ZHVtbXk=']);
  });
  it('6: Query-Parameter', () => {
    const r = weg('GET /api?token=abc123456&api_key=def123456&x=1', ['abc123456', 'def123456'], ['x=1']);
    expect(r.anzahl).toBe(2);
  });
  it('7: set -x-Präfix', () => { weg('+ PGPASSWORD=Dummy123 psql -h db', ['Dummy123'], ['psql -h db']); });
  it('8: PWD/PW als eigenständige Schlüssel, PWD-Pfad bleibt', () => {
    weg('pwd=Dummy123', ['Dummy123']);
    weg('PW: Dummy123', ['Dummy123']);
    weg('MYSQL_PWD=Dummy123', ['Dummy123']);
    const pfad = schwaerze('PWD=/home/madh\nOLDPWD=/root');
    expect(pfad.text).toBe('PWD=/home/madh\nOLDPWD=/root');
    expect(pfad.anzahl).toBe(0);
    expect(schwaerze('x PWD=/srv/app').anzahl).toBe(0);
  });
  it('8: GEHEIM_NAME — PWD/PW nur eigenständig', () => {
    for (const k of ['pwd', 'PW', 'DB_PWD', 'mysql_pw', 'password', 'passwordLastSet']) expect(GEHEIM_NAME.test(k), k).toBe(true);
    for (const k of ['cwd', 'pwdLastSet', 'upward', 'Encrypt', 'user', 'powershell']) expect(GEHEIM_NAME.test(k), k).toBe(false);
  });
  it('9: Nicht-Geheimnisse bleiben lesbar', () => {
    for (const e of ['Encrypt=True;TrustServerCertificate=False', 'token_count: 42', 'user=sa host=db port=5432', '"user": "sa"']) {
      const r = schwaerze(e);
      expect(r.text, e).toBe(e);
      expect(r.anzahl, e).toBe(0);
    }
    weg('passwordLastSet: 2026-11-15', ['2026-11-15']);
  });
});

describe('Schwärzung — Runde 1', () => {
  it('URL-Zugangsdaten mit Zeichen vor dem Schema (Regression)', () => {
    for (const e of ['+postgres://app:dummypass@db/x', '-postgres://app:dummypass@db/x', '.https://u:dummypass@h', '1-redis://u:dummypass@h']) expect(weg(e, ['dummypass']).anzahl, e).toBe(1);
  });
  it('Basic in JSON, Hashtable, ohne Kopfzeile', () => {
    weg('{"Authorization": "Basic ZHVtbXk6ZHVtbXk="}', ['ZHVtbXk6ZHVtbXk=']);
    weg('$h = @{ Authorization = "Basic ZHVtbXk6ZHVtbXk=" }', ['ZHVtbXk6ZHVtbXk=']);
    weg('header Basic dXNlcjpwYXNz', ['dXNlcjpwYXNz']);
    expect(schwaerze('Basic Settings').anzahl).toBe(0);
  });
  it('curl -u / --user: Teil nach dem Doppelpunkt', () => {
    weg('curl -u admin:Dummy1234 https://h', ['Dummy1234'], ['admin:', 'https://h']);
    weg('curl --user admin:Dummy1234 https://h', ['Dummy1234'], ['admin:']);
    weg("curl --user='admin:Dummy 1234' https://h", ['Dummy 1234'], ['admin:']);
    expect(schwaerze('curl -u admin https://h').anzahl).toBe(0);
  });
  it('mysql/sshpass mit Anführungszeichen', () => {
    weg("mysql -u root -p'Dummy 1234' db", ['Dummy', '1234'], ['db']);
    weg('sshpass -p "Dummy 1234" ssh h', ['Dummy', '1234'], ['ssh h']);
  });
  it('erkannter Schlüssel: Wert läuft über , und #', () => {
    expect(weg('x password=ab#cdefgh', ['ab', 'cdefgh']).text).toBe('x password=[geschwärzt]');
    weg('x secret=ab,cdefgh y', ['ab', 'cdefgh'], [' y']);
  });
  it('Schalter ohne Wert verschlucken keine Trennzeichen', () => {
    for (const e of ['Get-Item x -PassThru | Format-List', 'docker login --password-stdin < datei', 'tool --password-file /run/secrets/x', 'tool --password-file=/run/secrets/x', 'cmd --token | grep x', 'cmd --token > out']) {
      const r = schwaerze(e);
      expect(r.text, e).toBe(e);
      expect(r.anzahl, e).toBe(0);
    }
  });
  it('PWD-Pfad-Ausnahme nicht für Schalter', () => {
    weg('tool --pwd /secretvalue', ['/secretvalue']);
    weg('tool -pw /secretvalue', ['/secretvalue']);
  });
  it('Runde 2: curl -uX:Y angehängt, UID:GID bleibt', () => {
    weg('curl -uadmin:Dummy1234 https://h', ['Dummy1234'], ['-uadmin:', 'https://h']);
    weg('curl -u"admin:Dummy 1234" https://h', ['Dummy 1234'], ['admin:']);
    const r = schwaerze('docker run -u 1000:1000 curlimages/curl https://h');
    expect(r.text).toBe('docker run -u 1000:1000 curlimages/curl https://h');
    expect(r.anzahl).toBe(0);
  });
  it('Runde 3: UID:GID-Ausnahme nur bei Container-Aufruf (fail-closed)', () => {
    expect(weg('curl -u 48213:91047 https://h', ['91047']).anzahl).toBe(1);
    expect(weg('curl --user 1000:1000 https://h', [':1000 ']).anzahl).toBe(1);
    expect(weg('docker run --rm curlimages/curl -u 1000:1000 https://h', [':1000 ']).anzahl).toBe(1);
    for (const e of ['docker run -u 1000:1000 curlimages/curl', 'podman run -u 0:0 alpine wget https://h']) {
      const r = schwaerze(e);
      expect(r.text, e).toBe(e);
      expect(r.anzahl, e).toBe(0);
    }
  });
  it('Runde 2: --pwd=/x ist ein Schalterwert, keine PWD-Pfadangabe', () => {
    weg('tool --pwd=/secretvalue', ['/secretvalue']);
    expect(schwaerze('PWD=/home/madh').anzahl).toBe(0);
  });
  it('linear: 200 000 Zeichen in < 1 s', () => {
    const muster = ['a'.repeat(200_000), ' '.repeat(200_000), 'a=' + ' '.repeat(200_000), ';a'.repeat(100_000), '-p'.repeat(100_000), 'mysql ' + '-'.repeat(200_000),
      'password'.repeat(25_000), '"'.repeat(200_000), 'x:'.repeat(100_000), '--password '.repeat(18_000), 'Authorization: Basic ' + 'A'.repeat(200_000),
      'a.'.repeat(100_000), '\n'.repeat(200_000), '(a='.repeat(66_000), 'x="'.repeat(66_000), " -pw '".repeat(33_000), 'mysql '.repeat(33_000), 'p=a '.repeat(50_000),
      'token: '.repeat(28_000), 'sshpass -p '.repeat(18_000), 'curl -u '.repeat(25_000), 'Basic '.repeat(33_000), 'Authorization: ' + ' '.repeat(200_000),
      'curl ' + '-u 1:1 '.repeat(25_000), 'curl ' + '-u a:b '.repeat(25_000), 'docker run ' + '-u 1:1 '.repeat(25_000) + 'curl',
      '://a'.repeat(50_000), 'a://' + 'b'.repeat(200_000), 'Basic ' + 'a'.repeat(200_000)];
    for (const m of muster) {
      const t0 = performance.now();
      schwaerze(m);
      expect(performance.now() - t0, m.slice(0, 20)).toBeLessThan(1000);
    }
  });
});

describe('Schwärzung — deutsche Geheimnis-Namen', () => {
  const namen = ['kennwort', 'Passwort', 'PASSPHRASE', 'Geheimnis', 'db_kennwort'];
  for (const n of namen) {
    it(`${n}: am Zeilenanfang und mitten in der Zeile geschwärzt`, () => {
      expect(schwaerze(`${n}=Abc12345xyz`).text).not.toContain('Abc12345xyz');
      expect(schwaerze(`${n}: Abc12345xyz`).text).not.toContain('Abc12345xyz');
      expect(schwaerze(`Dienst läuft; ${n}=Abc12345xyz weiter`).text).not.toContain('Abc12345xyz');
      expect(schwaerze(`Dienst läuft
${n}: Abc12345xyz
ende`).text).not.toContain('Abc12345xyz');
    });
    it(`${n} als Schlüsselname`, () => { expect(GEHEIM_NAME.test(n), n).toBe(true); });
  }
  it('Kennwortrichtlinie aktiv (ohne Trennzeichen) bleibt unverändert', () => {
    expect(schwaerze('Kennwortrichtlinie aktiv').text).toBe('Kennwortrichtlinie aktiv');
  });
  it('Beweistext „schluessel pki:…“ bleibt unverändert', () => {
    expect(schwaerze('schluessel pki:root').text).toBe('schluessel pki:root');
  });
  it('linear: 200 000 Zeichen mit deutschen Namen < 1 s', () => {
    for (const m of ['kennwort: '.repeat(20_000), 'Geheimnis='.repeat(20_000), 'passphrase '.repeat(18_000), 'Kennwort'.repeat(25_000)]) {
      const t0 = performance.now();
      schwaerze(m);
      expect(performance.now() - t0, m.slice(0, 20)).toBeLessThan(1000);
    }
  });
});

// v1885 — Lücken gegenüber der alten CLI-Schwärzung (satellit-auftrag.ts), die jetzt dieselbe Funktion nutzt
describe('Schwärzung — Lücken aus dem CLI-Vergleich', () => {
  it('Authorization: Bearer mit kurzem Token wird geschwärzt (Kopfzeile = immer Token)', () => {
    weg('▶ curl -H "Authorization: Bearer abc.def" https://x', ['abc.def'], ['Authorization: Bearer', 'https://x']);
    weg('authorization: bearer kurz1', ['kurz1']);
  });
  it('Bearer im Fließtext ohne Kopfzeile bleibt lesbar', () => {
    const r = schwaerze('Der Bearer token wird erneuert');
    expect(r.text).toBe('Der Bearer token wird erneuert');
  });
  it('Geheimnis-Name mit kurzem Wert in Anführungszeichen', () => {
    weg('▶ export PASSWORD="a b"', ['a b'], ['PASSWORD=']);
    weg("db_token='x1'", ['x1'], ['db_token=']);
  });
  it('leerer Wert in Anführungszeichen bleibt (kein Geheimnis)', () => {
    expect(schwaerze('PASSWORD=""').text).toBe('PASSWORD=""');
  });
});
