import { describe, it, expect } from 'vitest';
import { toastTexte, appName } from './satellit-benachrichtigungen.js';

describe('toastTexte', () => {
  it('erstes <text> ist Titel, Rest Text, Entities aufgelöst', () => {
    const xml = '<toast><visual><binding template="ToastGeneric"><text>Neue Nachricht</text><text hint-maxLines="2">Max &amp; Moritz: Bist du da?</text><text>jetzt</text></binding></visual></toast>';
    expect(toastTexte(xml)).toEqual({ titel: 'Neue Nachricht', text: 'Max & Moritz: Bist du da? — jetzt' });
  });
  it('ein Text ohne Titel, leer ohne Texte', () => {
    expect(toastTexte('<toast><text> Nur eins </text></toast>')).toEqual({ text: 'Nur eins' });
    expect(toastTexte('<toast><image src="x"/></toast>')).toEqual({ text: '' });
    expect(toastTexte('<toast><text><![CDATA[Zurückblicken]]></text><text><![CDATA[Oktober 7]]></text></toast>')).toEqual({ titel: 'Zurückblicken', text: 'Oktober 7' });
  });
});

describe('appName', () => {
  it('kürzt Herausgeber und Paket-Hashes', () => {
    expect(appName('Microsoft.SkyDrive.Desktop')).toBe('SkyDrive.Desktop');
    expect(appName('com.nvidia.nvapp')).toBe('nvidia.nvapp');
    expect(appName('Microsoft.WindowsStore_8wekyb3d8bbwe!App')).toBe('WindowsStore');
    expect(appName('')).toBe('');
  });
});
