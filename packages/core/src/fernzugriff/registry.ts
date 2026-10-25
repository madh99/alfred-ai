/**
 * v1658 — Owner 25.10. („registry.lokalkraft.at sollte auf jeden Fall für Alfred aufgenommen werden“): Images über die Container-Registry
 * des eigenen GitLab übertragen. Der Token geht nur über stdin in eine temporäre Docker-Konfiguration auf dem Host, die am Ende
 * gelöscht wird — er steht nie in der Befehlszeile, im Log oder dauerhaft auf dem Host. Ohne I/O.
 */
export interface RegistryZugang { server: string; benutzer: string; token: string }

const SERVER = /^[a-z0-9][a-z0-9.-]{1,252}(:\d{2,5})?$/;
const PFAD = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){0,8}$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const LOKAL = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}(:[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(@sha256:[0-9a-f]{64})?$|^sha256:[0-9a-f]{64}$/;
const BENUTZER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function zielReferenz(server: string, ref: string): { pfad: string; tag: string } | { fehler: string } {
  if (!SERVER.test(server)) return { fehler: 'Registry-Server ungültig' };
  if (!ref.startsWith(`${server}/`)) return { fehler: `ziel muss in der eigenen Registry liegen (${server}/<projekt>/<name>:<tag>)` };
  const rest = ref.slice(server.length + 1);
  const i = rest.lastIndexOf(':');
  if (i < 0) return { fehler: 'ziel braucht einen Tag (…:<tag>), z. B. migration-20261025' };
  const pfad = rest.slice(0, i), tag = rest.slice(i + 1);
  if (!PFAD.test(pfad) || !TAG.test(tag)) return { fehler: 'ziel: Pfad nur a-z 0-9 . _ - und /, Tag nur A-Z a-z 0-9 . _ -' };
  return { pfad, tag };
}

export function holReferenz(server: string, ref: string): { pfad: string; digest: string } | { fehler: string } {
  if (!SERVER.test(server)) return { fehler: 'Registry-Server ungültig' };
  if (!ref.startsWith(`${server}/`)) return { fehler: `image muss aus der eigenen Registry kommen (${server}/…)` };
  const m = /^(.+)@(sha256:[0-9a-f]{64})$/.exec(ref.slice(server.length + 1));
  if (!m) return { fehler: 'image nur mit Digest (…@sha256:<64 Hex>) — so kommt am Ziel genau dieses Image an' };
  if (!PFAD.test(m[1]!)) return { fehler: 'image: Pfad nur a-z 0-9 . _ - und /' };
  return { pfad: m[1]!, digest: m[2]! };
}

export function lokaleReferenz(ref: string): boolean { return LOKAL.test(ref); }

/** Fernbefehl: anmelden (Token von stdin), taggen, hochladen; letzte Zeile DIGEST=sha256:… */
export function hochladenBefehl(z: RegistryZugang, lokal: string, ziel: string): string {
  if (!BENUTZER.test(z.benutzer)) throw new Error('Registry-Benutzer ungültig');
  return [
    'set -eu', 'd=$(mktemp -d /tmp/alfred-registry.XXXXXXXX)', 'trap \'rm -rf "$d"\' EXIT', 'export DOCKER_CONFIG="$d"',
    `docker login ${z.server} -u ${z.benutzer} --password-stdin >/dev/null`,
    `docker image inspect --format '{{.Id}}' ${lokal} >/dev/null`,
    `docker tag ${lokal} ${ziel}`,
    `docker push ${ziel} > "$d/push.log"`,
    `tail -n 3 "$d/push.log"`,
    `echo "DIGEST=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' ${ziel} | grep -F '${ziel.slice(0, ziel.lastIndexOf(':'))}@' | head -n 1 | sed 's/.*@//')"`,
    `docker logout ${z.server} >/dev/null 2>&1 || true`,
  ].join('\n');
}

/** Fernbefehl: anmelden (Token von stdin), per Digest holen, Digest prüfen; letzte Zeile IMAGE_ID=sha256:… */
export function holenBefehl(z: RegistryZugang, ref: string, digest: string): string {
  if (!BENUTZER.test(z.benutzer)) throw new Error('Registry-Benutzer ungültig');
  return [
    'set -eu', 'd=$(mktemp -d /tmp/alfred-registry.XXXXXXXX)', 'trap \'rm -rf "$d"\' EXIT', 'export DOCKER_CONFIG="$d"',
    `docker login ${z.server} -u ${z.benutzer} --password-stdin >/dev/null`,
    `docker pull -q ${ref} >/dev/null`,
    `docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' ${ref} | grep -qF '@${digest}'`,
    `echo "IMAGE_ID=$(docker image inspect --format '{{.Id}}' ${ref})"`,
    `docker logout ${z.server} >/dev/null 2>&1 || true`,
  ].join('\n');
}

/** Wert aus der letzten passenden Zeile KEY=… */
export function ausgabeWert(stdout: string, key: string): string | undefined {
  const z = stdout.split('\n').reverse().find(l => l.startsWith(`${key}=`));
  const w = z?.slice(key.length + 1).trim();
  return w && /^sha256:[0-9a-f]{64}$/.test(w) ? w : undefined;
}
