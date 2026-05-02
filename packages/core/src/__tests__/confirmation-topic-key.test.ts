import { describe, it, expect } from 'vitest';
import { computeTopicKey } from '../confirmation-queue.js';
import type { PendingConfirmation } from '@alfred/types';

function mkConf(overrides: Partial<PendingConfirmation>): PendingConfirmation {
  return {
    id: 'id-1',
    chatId: 'chat-1',
    platform: 'telegram',
    source: 'reasoning',
    sourceId: 'src-1',
    description: 'X',
    skillName: 'memory',
    skillParams: {},
    status: 'pending',
    createdAt: '2026-05-02T00:00:00Z',
    expiresAt: '2026-05-02T01:00:00Z',
    ...overrides,
  };
}

describe('computeTopicKey', () => {
  describe('ITSM incident creation', () => {
    it('uses skill_params.title — different titles → different keys', () => {
      const a = computeTopicKey(mkConf({
        skillName: 'itsm',
        skillParams: { action: 'create_incident', title: 'UniFi IPS-Alert-Flut', symptoms: '3000 alerts' },
        description: 'UniFi IPS-Alert-Flut in ITSM dokumentieren',
      }));
      const b = computeTopicKey(mkConf({
        skillName: 'itsm',
        skillParams: { action: 'create_incident', title: 'Commvault Backup-Job-Anomalie', symptoms: 'long jobs' },
        description: 'Commvault Backup-Job-Anomalie in ITSM dokumentieren',
      }));
      expect(a).not.toBe(b);
      expect(a).toBe('itsm:create_incident:unifi ips-alert-flut');
      expect(b).toBe('itsm:create_incident:commvault backup-job-anomalie');
    });

    it('same title → same key (proper dedup)', () => {
      const a = computeTopicKey(mkConf({
        skillName: 'itsm',
        skillParams: { action: 'create_incident', title: 'UniFi IPS Flood' },
        description: 'first request',
      }));
      const b = computeTopicKey(mkConf({
        skillName: 'itsm',
        skillParams: { action: 'create_incident', title: 'UniFi IPS Flood' },
        description: 'second request — different wording',
      }));
      expect(a).toBe(b);
    });

    it('create_problem and create_change_request also use title', () => {
      expect(computeTopicKey(mkConf({
        skillName: 'itsm',
        skillParams: { action: 'create_problem', title: 'Recurring MikroTik failures' },
        description: 'X',
      }))).toBe('itsm:create_problem:recurring mikrotik failures');
    });
  });

  describe('workflow / watch creation', () => {
    it('uses skill_params.name', () => {
      expect(computeTopicKey(mkConf({
        skillName: 'workflow',
        skillParams: { action: 'create', name: 'BMW Ladeplanung' },
        description: 'irrelevant',
      }))).toBe('workflow:create:bmw ladeplanung');
      expect(computeTopicKey(mkConf({
        skillName: 'watch',
        skillParams: { action: 'create', name: 'Battery low alert' },
        description: 'irrelevant',
      }))).toBe('watch:create:battery low alert');
    });
  });

  describe('reminder.set', () => {
    it('uses first 8 words of message', () => {
      const a = computeTopicKey(mkConf({
        skillName: 'reminder',
        skillParams: { action: 'set', message: 'BMW Werkstatt anrufen wegen Reparaturstatus' },
        description: 'X',
      }));
      const b = computeTopicKey(mkConf({
        skillName: 'reminder',
        skillParams: { action: 'set', message: 'BMW Werkstatt anrufen wegen Reparaturstatus' },
        description: 'Y — different desc',
      }));
      expect(a).toBe(b);
      expect(a).toBe('reminder:set:bmw werkstatt anrufen wegen reparaturstatus');
    });

    it('different reminder messages → different keys', () => {
      const a = computeTopicKey(mkConf({
        skillName: 'reminder',
        skillParams: { action: 'set', message: 'Sensor-Batterien austauschen' },
        description: 'X',
      }));
      const b = computeTopicKey(mkConf({
        skillName: 'reminder',
        skillParams: { action: 'set', message: 'Anthropic Rechnung bezahlen' },
        description: 'X',
      }));
      expect(a).not.toBe(b);
    });
  });

  describe('generic fallback', () => {
    it('uses sorted unique 4+ char words from description', () => {
      const key = computeTopicKey(mkConf({
        skillName: 'unknown_skill',
        skillParams: { action: 'do_something' },
        description: 'Wartung der Backup-Pipeline starten',
      }));
      expect(key).toMatch(/^unknown_skill:do_something:desc:/);
    });

    it('different descriptions → different fallback keys', () => {
      const a = computeTopicKey(mkConf({ description: 'First action with unique words alpha' }));
      const b = computeTopicKey(mkConf({ description: 'Second different action beta gamma delta' }));
      expect(a).not.toBe(b);
    });
  });

  describe('null when no signal', () => {
    it('returns null for empty description and no skill params', () => {
      const key = computeTopicKey(mkConf({ description: 'a b c' }));
      expect(key).toBeNull();
    });
  });

  describe('regression: the original bug case', () => {
    it('two ITSM incidents with same generic words but different titles → different keys', () => {
      // Reproduces the production incident: both confirmations had same skill (itsm),
      // same action (create_incident), and shared "ITSM" + "dokumentieren" in description.
      // Old keyword logic merged them; topic-key logic must keep them separate.
      const unifi = computeTopicKey(mkConf({
        skillName: 'itsm',
        skillParams: { action: 'create_incident', title: 'UniFi IPS-Alert-Flut: 3000 offene Alerts' },
        description: 'UniFi IPS-Alert-Flut in ITSM dokumentieren',
      }));
      const commvault = computeTopicKey(mkConf({
        skillName: 'itsm',
        skillParams: { action: 'create_incident', title: 'Commvault Backup-Anomaly ws22s-b01' },
        description: 'Commvault Backup-Job-Anomalie in ITSM dokumentieren',
      }));
      expect(unifi).not.toBe(commvault);
    });
  });
});
