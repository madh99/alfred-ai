/**
 * Spec Schwachstellen-Überwachung §3.1a — Zuordnung Container-Image → Anwendung mit ihren Schwachstellen-Quellen. Erweiterbar; Images ohne
 * Eintrag prüft Trivy (Basis-Pakete und erkennbare Sprach-Pakete), die Ansicht nennt sie „ohne Anwendungs-Zuordnung“.
 * Die Anwendungs-Quellen brauchen die laufende Version (OCI-Label oder Versions-Tag); ohne Version nur Trivy.
 */

/** nurTag: das OCI-Versions-Label des Images ist nicht die Anwendungs-Version (Realfall mongo:latest → „22.04“ = Ubuntu-Basis) */
export interface Anwendung { name: string; github?: string; cpe?: string; osv?: { oekosystem: string; paket: string }; nurTag?: boolean }

/** Schlüssel: Repository ohne Registry-Präfix (docker.io/library) und ohne Tag/Digest */
export const ANWENDUNGEN: Readonly<Record<string, Anwendung>> = {
  'vaultwarden/server': { name: 'Vaultwarden', github: 'dani-garcia/vaultwarden', cpe: 'dani-garcia:vaultwarden', osv: { oekosystem: 'crates.io', paket: 'vaultwarden' } },
  'matrixdotorg/synapse': { name: 'Synapse', github: 'element-hq/synapse', cpe: 'matrix:synapse', osv: { oekosystem: 'PyPI', paket: 'matrix-synapse' } },
  'coturn/coturn': { name: 'coturn', github: 'coturn/coturn', cpe: 'coturn_project:coturn' },
  'livekit/livekit-server': { name: 'LiveKit', github: 'livekit/livekit', osv: { oekosystem: 'Go', paket: 'github.com/livekit/livekit-server' } },
  'element-hq/lk-jwt-service': { name: 'Element Call JWT', github: 'element-hq/lk-jwt-service' },
  'vectorim/element-web': { name: 'Element Web', github: 'element-hq/element-web', osv: { oekosystem: 'npm', paket: 'element-web' } },
  'home-assistant/home-assistant': { name: 'Home Assistant', github: 'home-assistant/core', cpe: 'home-assistant:home-assistant', osv: { oekosystem: 'PyPI', paket: 'homeassistant' } },
  'rustdesk/rustdesk-server': { name: 'RustDesk Server', github: 'rustdesk/rustdesk-server' },
  'lissy93/dashy': { name: 'Dashy', github: 'Lissy93/dashy' },
  'open-webui/open-webui': { name: 'Open WebUI', github: 'open-webui/open-webui', osv: { oekosystem: 'PyPI', paket: 'open-webui' } },
  'jc21/nginx-proxy-manager': { name: 'Nginx Proxy Manager', github: 'NginxProxyManager/nginx-proxy-manager' },
  'portainer/portainer-ce': { name: 'Portainer', github: 'portainer/portainer', cpe: 'portainer:portainer' },
  'jwetzell/guacamole': { name: 'Guacamole', cpe: 'apache:guacamole' },
  'nodered/node-red': { name: 'Node-RED', github: 'node-red/node-red', osv: { oekosystem: 'npm', paket: 'node-red' } },
  'dpage/pgadmin4': { name: 'pgAdmin 4', github: 'pgadmin-org/pgadmin4', cpe: 'pgadmin:pgadmin_4', osv: { oekosystem: 'PyPI', paket: 'pgadmin4' } },
  'fallenbagel/jellyseerr': { name: 'Jellyseerr', github: 'Fallenbagel/jellyseerr' },
  'linuxserver/ombi': { name: 'Ombi', github: 'Ombi-app/Ombi' },
  'davidusb-geek/emhass': { name: 'EMHASS', github: 'davidusb-geek/emhass', osv: { oekosystem: 'PyPI', paket: 'emhass' } },
  'nicolargo/glances': { name: 'Glances', github: 'nicolargo/glances', osv: { oekosystem: 'PyPI', paket: 'glances' } },
  wordpress: { name: 'WordPress', cpe: 'wordpress:wordpress' },
  mariadb: { name: 'MariaDB', cpe: 'mariadb:mariadb' },
  mysql: { name: 'MySQL', cpe: 'oracle:mysql' },
  postgres: { name: 'PostgreSQL', cpe: 'postgresql:postgresql' },
  redis: { name: 'Redis', cpe: 'redis:redis' },
  mongo: { name: 'MongoDB', cpe: 'mongodb:mongodb', nurTag: true },
  nginx: { name: 'nginx', cpe: 'f5:nginx' },
};

/** „ghcr.io/element-hq/lk-jwt-service:latest“ → „element-hq/lk-jwt-service“; „docker.io/library/redis:7“ → „redis“ */
export function imageRepo(image: string): string {
  let r = image.split('@')[0]!;
  const letzter = r.lastIndexOf(':'); if (letzter > r.lastIndexOf('/')) r = r.slice(0, letzter);
  const teile = r.split('/');
  if ((teile.length > 1 && /[.:]/.test(teile[0]!)) || teile[0] === 'localhost') teile.shift();
  if (teile[0] === 'library') teile.shift();
  return teile.join('/').toLowerCase();
}

/** Laufende Version: OCI-Label, sonst ein Versions-Tag (1.30.5, v1.9.8, 16, 8.0); „latest“, „main“, „master“ sind keine */
export function laufendeVersion(image: string, label?: string): string | undefined {
  if (label && /^v?\d+(\.\d+)*([-+.][\w.]+)?$/.test(label)) return label;
  const tag = /:([\w.-]+)$/.exec(image.split('@')[0]!)?.[1];
  return tag && /^v?\d+(\.\d+)*$/.test(tag) ? tag : undefined;
}

/** Veröffentlichte Host-Ports aus docker ps („0.0.0.0:181->80/tcp, :::181->80/tcp“) */
export function veroeffentlichtePorts(ports: string): number[] {
  return [...new Set([...ports.matchAll(/:(\d{1,5})->/g)].map(m => Number(m[1])))];
}

/**
 * Von außen erreichbar (Spec §3.3): ein aktiver Proxy-Host (Nginx Proxy Manager) leitet auf IP oder Namen des Hosts und einen der
 * veröffentlichten Ports des Containers weiter. UniFi-Portweiterleitungen folgen in Etappe D.
 */
export function vonAussenErreichbar(proxies: Array<{ forwardHost: string; forwardPort: number }>, host: { name: string; ip?: string }, ports: number[]): boolean {
  const ziele = new Set([host.name.toLowerCase(), ...(host.ip ? [host.ip] : [])]);
  return proxies.some(p => ziele.has(p.forwardHost.toLowerCase()) && ports.includes(p.forwardPort));
}
