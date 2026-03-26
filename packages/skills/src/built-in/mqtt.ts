import { Skill } from '../skill.js';
import type { SkillMetadata, SkillContext, SkillResult, MqttConfig } from '@alfred/types';

type Action = 'publish' | 'subscribe' | 'status' | 'devices' | 'set' | 'get';

export class MqttSkill extends Skill {
  private mqttModule: any;
  private client: any;
  private connected = false;
  private subscribedTopics = new Set<string>();
  private readonly prefix: string;

  readonly metadata: SkillMetadata = {
    name: 'mqtt',
    description:
      'MQTT Geräte steuern: Nachrichten senden/empfangen, Zigbee2MQTT Geräte steuern, ' +
      'Sensordaten lesen. MQTT, Zigbee, Sensor, Temperatur, Luftfeuchtigkeit, ' +
      'Schalter, Licht, Tür, Fenster, Bewegung, IoT, Smart Home, Tasmota, Shelly, ESPHome.',
    version: '1.0.0',
    riskLevel: 'write',
    category: 'infrastructure',
    timeoutMs: 15_000,
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['publish', 'subscribe', 'status', 'devices', 'set', 'get'],
          description: 'MQTT-Aktion.',
        },
        topic: {
          type: 'string',
          description: 'MQTT-Topic (für publish/subscribe).',
        },
        payload: {
          type: 'string',
          description: 'Nachricht/Payload (für publish). Bei JSON als String übergeben.',
        },
        retain: {
          type: 'boolean',
          description: 'Retained Message (Default: false).',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in Sekunden für subscribe/get (Default: 10).',
        },
        device: {
          type: 'string',
          description: 'Zigbee2MQTT Gerätename (für set/get).',
        },
        property: {
          type: 'string',
          description: 'Eigenschaft (für set/get, z.B. "state", "brightness", "temperature").',
        },
        value: {
          type: 'string',
          description: 'Wert (für set, z.B. "ON", "OFF", "128").',
        },
      },
    },
  };

  constructor(private readonly config: MqttConfig) {
    super();
    this.prefix = config.topicPrefix ?? 'zigbee2mqtt';
  }

  async execute(params: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = params.action as Action;

    switch (action) {
      case 'publish': return this.handlePublish(params);
      case 'subscribe': return this.handleSubscribe(params);
      case 'status': return this.handleStatus();
      case 'devices': return this.handleDevices(params);
      case 'set': return this.handleSet(params);
      case 'get': return this.handleGet(params);
      default:
        return { success: false, error: `Unbekannte Aktion: ${action}` };
    }
  }

  private async handlePublish(params: Record<string, unknown>): Promise<SkillResult> {
    const topic = params.topic as string | undefined;
    if (!topic) return { success: false, error: 'topic ist erforderlich.' };

    const payload = params.payload as string ?? '';
    const retain = params.retain as boolean ?? false;

    await this.ensureConnected();
    await this.publishAsync(topic, payload, retain);

    return {
      success: true,
      data: { topic, payload, retain },
      display: `Nachricht an "${topic}" gesendet: ${payload.slice(0, 100)}`,
    };
  }

  private async handleSubscribe(params: Record<string, unknown>): Promise<SkillResult> {
    const topic = params.topic as string | undefined;
    if (!topic) return { success: false, error: 'topic ist erforderlich.' };

    const timeout = ((params.timeout as number) ?? 10) * 1000;

    await this.ensureConnected();
    const message = await this.waitForMessage(topic, timeout);

    if (!message) {
      return { success: true, data: { topic, message: null }, display: `Kein Nachricht auf "${topic}" innerhalb ${timeout / 1000}s empfangen.` };
    }

    const parsed = this.tryParseJson(message.payload);
    return {
      success: true,
      data: parsed ?? message.payload,
      display: `${topic}: ${JSON.stringify(parsed ?? message.payload)}`,
    };
  }

  private async handleStatus(): Promise<SkillResult> {
    const isConnected = this.connected && this.client;
    return {
      success: true,
      data: {
        connected: isConnected,
        broker: this.config.brokerUrl,
        subscribedTopics: [...this.subscribedTopics],
        prefix: this.prefix,
      },
      display: isConnected
        ? `Verbunden mit ${this.config.brokerUrl}. ${this.subscribedTopics.size} Topic(s) abonniert.`
        : `Nicht verbunden. Broker: ${this.config.brokerUrl}`,
    };
  }

  private async handleDevices(params: Record<string, unknown>): Promise<SkillResult> {
    const timeout = ((params.timeout as number) ?? 10) * 1000;
    const devicesTopic = `${this.prefix}/bridge/devices`;

    await this.ensureConnected();
    const message = await this.waitForMessage(devicesTopic, timeout);

    if (!message) {
      return { success: false, error: `Keine Antwort auf "${devicesTopic}". Ist Zigbee2MQTT aktiv?` };
    }

    const devices = this.tryParseJson(message.payload);
    if (!Array.isArray(devices)) {
      return { success: false, error: 'Unerwartetes Format von Zigbee2MQTT bridge/devices.' };
    }

    const summary = devices.map((d: any) => ({
      name: d.friendly_name ?? d.ieee_address,
      type: d.type,
      model: d.definition?.model,
      vendor: d.definition?.vendor,
      description: d.definition?.description,
      supported: d.supported ?? true,
    }));

    return {
      success: true,
      data: summary,
      display: `${summary.length} Zigbee-Geräte gefunden:\n${summary.map((d: any) => `- ${d.name} (${d.vendor ?? ''} ${d.model ?? d.type})`).join('\n')}`,
    };
  }

  private async handleSet(params: Record<string, unknown>): Promise<SkillResult> {
    const device = params.device as string | undefined;
    if (!device) return { success: false, error: 'device ist erforderlich.' };

    const property = params.property as string | undefined;
    const value = params.value as string | undefined;
    if (!property || value === undefined) return { success: false, error: 'property und value sind erforderlich.' };

    await this.ensureConnected();

    const topic = `${this.prefix}/${device}/set`;
    const payload = JSON.stringify({ [property]: this.coerceValue(value) });
    await this.publishAsync(topic, payload, false);

    return {
      success: true,
      data: { device, property, value },
      display: `${device}: ${property} = ${value}`,
    };
  }

  private async handleGet(params: Record<string, unknown>): Promise<SkillResult> {
    const device = params.device as string | undefined;
    if (!device) return { success: false, error: 'device ist erforderlich.' };

    const property = params.property as string | undefined;
    const timeout = ((params.timeout as number) ?? 10) * 1000;

    await this.ensureConnected();

    // Subscribe to device topic for response
    const responseTopic = `${this.prefix}/${device}`;

    // Send get request
    const getTopic = `${this.prefix}/${device}/get`;
    const payload = property ? JSON.stringify({ [property]: '' }) : JSON.stringify({ state: '' });
    await this.publishAsync(getTopic, payload, false);

    // Wait for response
    const message = await this.waitForMessage(responseTopic, timeout);
    if (!message) {
      return { success: false, error: `Keine Antwort von "${device}" innerhalb ${timeout / 1000}s.` };
    }

    const parsed = this.tryParseJson(message.payload);
    return {
      success: true,
      data: parsed ?? message.payload,
      display: `${device}: ${JSON.stringify(parsed ?? message.payload)}`,
    };
  }

  // --- Connection management ---

  private async loadMqtt(): Promise<any> {
    if (!this.mqttModule) {
      try {
        this.mqttModule = await (Function('return import("mqtt")')() as Promise<any>);
      } catch {
        throw new Error('mqtt Paket nicht verfügbar.');
      }
    }
    return this.mqttModule;
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected && this.client) return;

    const mqtt = await this.loadMqtt();
    const connectFn = mqtt.connectAsync ?? mqtt.default?.connectAsync ?? mqtt.connect ?? mqtt.default?.connect;

    if (!connectFn) throw new Error('mqtt.connect nicht gefunden');

    const options: Record<string, unknown> = {
      clientId: this.config.clientId ?? `alfred_mqtt_${Date.now()}`,
      reconnectPeriod: 5000,
      connectTimeout: 10_000,
      clean: true,
    };

    if (this.config.username) {
      options.username = this.config.username;
      options.password = this.config.password;
    }

    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error('MQTT-Verbindung Timeout (10s)')), 10_000);

      this.client = (mqtt.connect ?? mqtt.default?.connect)(this.config.brokerUrl, options);

      this.client.on('connect', () => {
        clearTimeout(timeoutId);
        this.connected = true;
        resolve();
      });

      this.client.on('error', (err: Error) => {
        clearTimeout(timeoutId);
        this.connected = false;
        reject(new Error(`MQTT-Fehler: ${err.message}`));
      });

      this.client.on('close', () => {
        this.connected = false;
      });

      this.client.on('reconnect', () => {
        // Auto-reconnect handled by mqtt library
      });
    });
  }

  private publishAsync(topic: string, payload: string, retain: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.publish(topic, payload, { retain, qos: 1 }, (err: Error | null) => {
        if (err) reject(new Error(`Publish fehlgeschlagen: ${err.message}`));
        else resolve();
      });
    });
  }

  private waitForMessage(topic: string, timeoutMs: number): Promise<{ topic: string; payload: string } | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.client.unsubscribe(topic);
        this.subscribedTopics.delete(topic);
        resolve(null);
      }, timeoutMs);

      const handler = (receivedTopic: string, message: Buffer) => {
        // Check if topic matches (supports wildcards via mqtt lib matching)
        if (receivedTopic === topic || this.topicMatches(topic, receivedTopic)) {
          clearTimeout(timer);
          this.client.removeListener('message', handler);
          this.client.unsubscribe(topic);
          this.subscribedTopics.delete(topic);
          resolve({ topic: receivedTopic, payload: message.toString('utf-8') });
        }
      };

      this.client.on('message', handler);
      this.client.subscribe(topic, { qos: 1 });
      this.subscribedTopics.add(topic);
    });
  }

  private topicMatches(pattern: string, topic: string): boolean {
    // Simple wildcard matching for MQTT topics
    if (pattern === topic) return true;
    const patternParts = pattern.split('/');
    const topicParts = topic.split('/');
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i] === '#') return true;
      if (patternParts[i] === '+') continue;
      if (patternParts[i] !== topicParts[i]) return false;
    }
    return patternParts.length === topicParts.length;
  }

  private tryParseJson(text: string): any {
    try { return JSON.parse(text); } catch { return null; }
  }

  private coerceValue(value: string): string | number | boolean {
    if (value === 'true') return true;
    if (value === 'false') return false;
    const num = Number(value);
    if (!isNaN(num) && value.trim() !== '') return num;
    return value;
  }

  /**
   * Gracefully disconnect from the MQTT broker.
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        this.client.end(true);
      } catch { /* ignore */ }
      this.client = null;
      this.connected = false;
      this.subscribedTopics.clear();
    }
  }
}
