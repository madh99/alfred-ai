import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

/**
 * v1229 — Die Browser-Hand des Satelliten: Alfred bedient einen Browser auf dem Gerät.
 *
 * Eigenes Profil (~/.alfred/browser-profil): Chromium-Browser erlauben keine Fernsteuerung
 * des Standardprofils mehr, und es ist ohnehin richtig, dass der Owner selbst entscheidet,
 * wo Alfred angemeldet ist. Der Browser bleibt sichtbar — der Owner sieht, was Alfred tut.
 *
 * Operationen: oeffnen, lesen (Text + Element-Karte), klicken, tippen, zurueck, screenshot,
 * schliessen. Klicken und Tippen sind im Manifest `bestaetigen`; Zahlungs-, Bestell- und
 * Anmeldeseiten sind für Alfred gesperrt (`nie`, deterministisch an URL und Beschriftung).
 */
interface PPage {
  goto(url: string, o?: Record<string, unknown>): Promise<unknown>;
  evaluate<T>(fn: string | ((...a: unknown[]) => T), ...args: unknown[]): Promise<T>;
  url(): string;
  title(): Promise<string>;
  click(sel: string): Promise<void>;
  type(sel: string, text: string, o?: { delay?: number }): Promise<void>;
  focus(sel: string): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  goBack(o?: Record<string, unknown>): Promise<unknown>;
  screenshot(o: Record<string, unknown>): Promise<Uint8Array | string>;
  waitForNetworkIdle?(o?: { idleTime?: number; timeout?: number }): Promise<void>;
  setViewport(v: { width: number; height: number }): Promise<void>;
}
interface PBrowser { pages(): Promise<PPage[]>; newPage(): Promise<PPage>; close(): Promise<void>; isConnected?(): boolean; on(ev: string, fn: () => void): void }
interface PuppeteerCore { launch(o: Record<string, unknown>): Promise<PBrowser> }

import { istGesperrteUrl, istGesperrteBeschriftung, formatiereSeite, type BrowserElement } from '@alfred/core';
export { formatiereSeite };

export function browserPfad(konfiguriert?: string): string | undefined {
  if (konfiguriert && existsSync(konfiguriert)) return konfiguriert;
  const kandidaten = process.platform === 'win32'
    ? ['C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
    : process.platform === 'darwin'
      ? ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/brave-browser', '/usr/bin/brave', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return kandidaten.find(p => existsSync(p));
}

export class BrowserHand {
  private browser?: PBrowser;
  private page?: PPage;
  private elemente: BrowserElement[] = [];

  constructor(private readonly opts: { executablePath?: string; profil?: string }) {}

  private async seite(): Promise<PPage> {
    if (this.browser && this.page && (this.browser.isConnected?.() ?? true)) return this.page;
    const exe = browserPfad(this.opts.executablePath);
    if (!exe) throw new Error('Kein Browser gefunden (Brave/Chrome/Edge). Pfad in ~/.alfred/geraet.json als "browserPfad" eintragen.');
    const profil = this.opts.profil ?? path.join(os.homedir(), '.alfred', 'browser-profil');
    mkdirSync(profil, { recursive: true });
    const mod = await (Function('return import("puppeteer-core")')() as Promise<{ default?: PuppeteerCore } & PuppeteerCore>);
    const pup = (mod.default ?? mod) as PuppeteerCore;
    this.browser = await pup.launch({ executablePath: exe, userDataDir: profil, headless: false, defaultViewport: null, args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,900'] });
    this.browser.on('disconnected', () => { this.browser = undefined; this.page = undefined; });
    const pages = await this.browser.pages();
    this.page = pages[0] ?? await this.browser.newPage();
    return this.page;
  }

  async oeffnen(url: string): Promise<{ url: string; titel: string; text: string }> {
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const p = await this.seite();
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await p.waitForNetworkIdle?.({ idleTime: 500, timeout: 8_000 }).catch(() => undefined);
    return this.kurz(p);
  }

  async lesen(): Promise<{ url: string; titel: string; text: string; elemente: BrowserElement[] }> {
    const p = await this.seite();
    const k = await this.kurz(p, 3000);
    this.elemente = await p.evaluate<BrowserElement[]>(`(() => {
      const sichtbar = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const out = []; let i = 0;
      document.querySelectorAll('[data-alfred-idx]').forEach(el => el.removeAttribute('data-alfred-idx'));
      for (const el of document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"]')) {
        if (!sichtbar(el)) continue;
        const tag = el.tagName.toLowerCase();
        const typ = el.getAttribute('type') || undefined;
        if (tag === 'input' && typ === 'hidden') continue;
        const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.value || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
        if (!text && tag !== 'input' && tag !== 'textarea' && tag !== 'select') continue;
        i += 1; el.setAttribute('data-alfred-idx', String(i));
        const e = { i, tag, text, typ };
        if (tag === 'a') { const h = el.getAttribute('href') || ''; e.href = h.slice(0, 160); }
        out.push(e);
        if (out.length >= 120) break;
      }
      return out;
    })()`);
    return { ...k, elemente: this.elemente };
  }

  async klicken(index: number): Promise<{ url: string; titel: string; text: string; geklickt: string }> {
    const p = await this.seite();
    const el = this.elemente.find(e => e.i === index);
    if (!el) throw new Error(`Element ${index} unbekannt — zuerst „lesen" ausführen (Element-Karte).`);
    if (istGesperrteUrl(p.url())) throw new Error(`Seite gesperrt für Alfred (Zahlung/Bestellung/Anmeldung): ${p.url()}`);
    if (istGesperrteBeschriftung(el.text)) throw new Error(`Element „${el.text}" ist für Alfred gesperrt (Kauf/Bestellung/Anmeldung bleibt beim Owner).`);
    if (el.href && istGesperrteUrl(el.href)) throw new Error(`Link führt auf eine gesperrte Seite: ${el.href}`);
    await p.click(`[data-alfred-idx="${index}"]`);
    await p.waitForNetworkIdle?.({ idleTime: 500, timeout: 8_000 }).catch(() => undefined);
    return { ...(await this.kurz(p)), geklickt: el.text };
  }

  async tippen(index: number, text: string, enter = false): Promise<{ url: string; titel: string; text: string }> {
    const p = await this.seite();
    const el = this.elemente.find(e => e.i === index);
    if (!el) throw new Error(`Element ${index} unbekannt — zuerst „lesen" ausführen.`);
    if (el.typ === 'password') throw new Error('Passwortfelder sind für Alfred gesperrt.');
    if (istGesperrteUrl(p.url())) throw new Error(`Seite gesperrt für Alfred (Zahlung/Bestellung/Anmeldung): ${p.url()}`);
    const sel = `[data-alfred-idx="${index}"]`;
    await p.focus(sel);
    await p.evaluate(`(() => { const el = document.querySelector('${sel}'); if (el && 'value' in el) el.value = ''; })()`);
    await p.type(sel, text, { delay: 15 });
    if (enter) { await p.keyboard.press('Enter'); await p.waitForNetworkIdle?.({ idleTime: 500, timeout: 8_000 }).catch(() => undefined); }
    return this.kurz(p);
  }

  async zurueck(): Promise<{ url: string; titel: string; text: string }> {
    const p = await this.seite();
    await p.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => undefined);
    return this.kurz(p);
  }

  async screenshot(): Promise<string> {
    const p = await this.seite();
    const b = await p.screenshot({ type: 'jpeg', quality: 60, encoding: 'base64' });
    return typeof b === 'string' ? b : Buffer.from(b).toString('base64');
  }

  async schliessen(): Promise<void> {
    const b = this.browser; this.browser = undefined; this.page = undefined; this.elemente = [];
    if (b) await b.close().catch(() => undefined);
  }

  private async kurz(p: PPage, maxText = 1500): Promise<{ url: string; titel: string; text: string }> {
    const text = await p.evaluate<string>(`(() => { const c = document.body ? document.body.cloneNode(true) : null; if (!c) return ''; c.querySelectorAll('script,style,noscript,svg').forEach(e => e.remove()); return (c.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim(); })()`).catch(() => '');
    return { url: p.url(), titel: await p.title().catch(() => ''), text: text.slice(0, maxText) };
  }
}

