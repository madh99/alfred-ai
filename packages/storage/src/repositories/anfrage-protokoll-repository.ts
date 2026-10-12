import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

/**
 * v1374 — Spec „Lernende Helfer" L0 (Owner-Freigabe 12.10., Textauszüge ≤ 200 Zeichen, 90 Tage): je Gesprächsanfrage eine
 * Zeile als Lernsignal — Absicht, genutzte Werkzeuge mit Ausgang, Stufe/Modell, Dauer, Kosten, Werkzeugrunden und das
 * Folgesignal (korrigiert, wiederholt, abgebrochen). Reine Messung; nichts entscheidet darauf.
 */
export type Folgesignal = 'korrigiert' | 'wiederholt' | 'abgebrochen';

export interface AnfrageEintrag {
  id: string;
  userId?: string;
  zeit: string;
  kanal: string;
  chatId: string;
  absicht: string[];
  textAuszug: string;
  werkzeuge: Array<{ skill: string; aktion?: string; ok: boolean }>;
  stufe?: string;
  modell?: string;
  dauerMs: number;
  kostenUsd: number;
  runden: number;
  folgesignal?: Folgesignal;
}

export class AnfrageProtokollRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  async anlegen(e: Omit<AnfrageEintrag, 'id' | 'zeit'> & { zeit?: string }): Promise<string> {
    const id = randomUUID();
    await this.db.execute(
      `INSERT INTO anfrage_protokoll (id, user_id, zeit, kanal, chat_id, absicht, text_auszug, werkzeuge, stufe, modell, dauer_ms, kosten_usd, runden, folgesignal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, e.userId ?? null, e.zeit ?? new Date().toISOString(), e.kanal, e.chatId, JSON.stringify(e.absicht), e.textAuszug.slice(0, 200),
        JSON.stringify(e.werkzeuge), e.stufe ?? null, e.modell ?? null, Math.round(e.dauerMs), e.kostenUsd, e.runden, e.folgesignal ?? null],
    );
    return id;
  }

  /** Letzte Anfrage desselben Benutzers im selben Chat seit `seitIso` (für das Folgesignal der nächsten Nachricht). v1375: je Benutzer. */
  async letzteImChat(userId: string | undefined, chatId: string, seitIso: string): Promise<AnfrageEintrag | null> {
    const r = await this.db.queryOne(userId
      ? `SELECT * FROM anfrage_protokoll WHERE user_id = ? AND chat_id = ? AND zeit >= ? ORDER BY zeit DESC LIMIT 1`
      : `SELECT * FROM anfrage_protokoll WHERE user_id IS NULL AND chat_id = ? AND zeit >= ? ORDER BY zeit DESC LIMIT 1`,
      userId ? [userId, chatId, seitIso] : [chatId, seitIso]) as Record<string, unknown> | undefined;
    return r ? this.map(r) : null;
  }

  async setzeFolgesignal(id: string, signal: Folgesignal): Promise<void> {
    await this.db.execute(`UPDATE anfrage_protokoll SET folgesignal = ? WHERE id = ? AND folgesignal IS NULL`, [signal, id]);
  }

  /** v1375 — nur die Einträge eines Benutzers (Mandantentrennung). */
  async seit(userId: string, seitIso: string, limit = 5000): Promise<AnfrageEintrag[]> {
    const rows = await this.db.query(`SELECT * FROM anfrage_protokoll WHERE user_id = ? AND zeit >= ? ORDER BY zeit LIMIT ?`, [userId, seitIso, limit]) as Record<string, unknown>[];
    return rows.map(r => this.map(r));
  }

  /** v1375 — Gespräch gelöscht → auch dessen Protokoll (Auszüge dürfen den Verlauf nicht überleben). */
  async loescheChat(chatId: string): Promise<number> {
    const r = await this.db.execute(`DELETE FROM anfrage_protokoll WHERE chat_id = ?`, [chatId]);
    return r.changes ?? 0;
  }

  async aufraeumen(tage = 90): Promise<number> {
    const r = await this.db.execute(`DELETE FROM anfrage_protokoll WHERE zeit < ?`, [new Date(Date.now() - tage * 86_400_000).toISOString()]);
    return r.changes ?? 0;
  }

  private map(r: Record<string, unknown>): AnfrageEintrag {
    const json = <T>(v: unknown, d: T): T => { try { return v ? JSON.parse(String(v)) as T : d; } catch { return d; } };
    return {
      id: String(r.id), userId: (r.user_id as string | null) ?? undefined, zeit: String(r.zeit), kanal: String(r.kanal), chatId: String(r.chat_id),
      absicht: json<string[]>(r.absicht, []), textAuszug: String(r.text_auszug ?? ''), werkzeuge: json(r.werkzeuge, []),
      stufe: (r.stufe as string | null) ?? undefined, modell: (r.modell as string | null) ?? undefined, dauerMs: Number(r.dauer_ms ?? 0),
      kostenUsd: Number(r.kosten_usd ?? 0), runden: Number(r.runden ?? 0), folgesignal: (r.folgesignal as Folgesignal | null) ?? undefined,
    };
  }
}
