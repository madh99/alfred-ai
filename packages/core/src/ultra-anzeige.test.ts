import { describe, expect, it } from 'vitest';
import { ultraAnzeige } from './message-pipeline.js';

describe('Spec Stufe ultra U4 — Auslöser der letzten Antwort für die App', () => {
  it('ohne ultra kein Auslöser', () => {
    expect(ultraAnzeige(undefined)).toEqual({});
    expect(ultraAnzeige({ tier: 'strong' })).toEqual({});
  });
  it('ultra ohne Grund = ausdrücklich gewählt', () => {
    expect(ultraAnzeige({ tier: 'ultra' })).toEqual({ grund: 'ausdrücklich', grundText: 'ausdrücklich gewählt' });
  });
  it('Eskalation mit lesbarem Text', () => {
    expect(ultraAnzeige({ tier: 'ultra', ultraGrund: 'eskalation:einwand' })).toEqual({ grund: 'eskalation:einwand', grundText: 'Eskalation (Einwand)' });
  });
});
