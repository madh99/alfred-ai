#version 460 core
// 1.68.0 (Owner 20.10.: „a+b+c+d+e bitte umsetzen“) — die Kugel der Unterhaltung als Shader: fließendes Plasma im Inneren,
// ein Rand, der sich mit der Stimme verformt, Wellen beim Zuhören (nach innen) und Sprechen (nach außen), kreisende Teilchen
// beim Nachdenken, entfärbt bei Stumm. Alle Zustände kommen als Gewichte 0..1 (in Dart geglättet), damit Übergänge fließen.
#include <flutter/runtime_effect.glsl>

precision mediump float;

uniform vec2 uSize;        // 0, 1
uniform float uZeit;       // 2
uniform float uPegel;      // 3  Lautstärke: Mikrofon (zuhören) bzw. Alfreds Ausgabe (sprechen)
uniform float uTief;       // 4  Frequenzbänder des Mikrofons
uniform float uMittel;     // 5
uniform float uHoch;       // 6
uniform float uHoert;      // 7  Zustandsgewichte
uniform float uDenkt;      // 8
uniform float uSpricht;    // 9
uniform float uStumm;      // 10
uniform vec3 uFarbe;       // 11–13  Stimmung (neutral blau, Warnung bernstein, erledigt grün)
uniform vec3 uHintergrund; // 14–16

out vec4 fragColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}

void main() {
  vec2 frag = FlutterFragCoord().xy;
  float s = min(uSize.x, uSize.y);
  vec2 p = (frag - 0.5 * uSize) / s * 2.0;
  float r = length(p);
  float a = atan(p.y, p.x);
  float t = uZeit;

  float energie = clamp(uPegel, 0.0, 1.0);
  // Rand: ruhiges Atmen, organische Verformung (tiefe Stimme bewegt den Umriss, hohe lässt ihn fein zittern)
  // auf dem Kreis gerechnet (cos/sin statt Winkel): sonst Naht bei ±180°
  float wob = fbm(vec2(cos(a), sin(a)) * 1.3 + vec2(t * 0.35, t * 0.28)) - 0.5;
  float basis = 0.50 + 0.025 * sin(t * 2.0);
  float rand = basis * (1.0 + energie * (0.10 + 0.14 * uSpricht) + wob * (0.08 + 0.30 * uTief + 0.18 * energie) + uHoch * 0.05 * sin(a * 12.0 + t * 6.0));

  // Inneres: zweistufiges Plasma
  vec2 q = p * 1.6;
  float pl = fbm(q + vec2(t * 0.25, -t * 0.2) + (fbm(q * 1.7 - t * 0.15) - 0.5) * 1.6);
  float innen = 1.0 - smoothstep(rand - 0.015, rand + 0.005, r);
  vec3 farbe = mix(uFarbe * 0.30, uFarbe * 1.1, pl);
  farbe += vec3(1.0) * pow(pl, 3.0) * (0.35 + uMittel * 0.65);
  farbe += mix(uFarbe, vec3(1.0), 0.5) * exp(-r * r * 9.0) * (0.25 + energie * 0.6); // Kernlicht
  float fresnel = smoothstep(rand - 0.14, rand, r) * innen;
  farbe += mix(uFarbe, vec3(1.0), 0.5) * fresnel * 0.7;
  vec3 col = farbe * innen;

  // Schein außen
  float d = max(r - rand, 0.0);
  float aussen = 1.0 - innen;
  col += uFarbe * exp(-d * 7.0) * (0.30 + energie * 0.6) * aussen;
  // Sprechen: Ringe laufen nach außen, so stark wie Alfreds Stimme
  float welleAus = sin((r - t * 0.9) * 28.0) * 0.5 + 0.5;
  col += uFarbe * uSpricht * energie * welleAus * exp(-d * 5.5) * aussen * 0.7;
  // Zuhören: Ringe laufen nach innen, stärker, wenn du sprichst
  float welleEin = sin((r + t * 0.7) * 22.0) * 0.5 + 0.5;
  col += uFarbe * uHoert * (0.12 + energie * 0.8) * welleEin * exp(-d * 5.0) * aussen * 0.45;
  // Nachdenken: Teilchen kreisen um den Kern
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    float w = t * (0.55 + 0.05 * fi) + fi * 0.5236;
    float rad = rand * (1.16 + 0.07 * sin(t * 1.3 + fi));
    vec2 pos = vec2(cos(w), sin(w)) * rad;
    float dd = length(p - pos);
    col += vec3(0.9, 0.95, 1.0) * uDenkt * exp(-dd * dd * 1100.0) * 1.3;
  }

  // Stumm: entfärbt und gedämpft
  float grau = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(grau) * 0.55, uStumm);

  fragColor = vec4(uHintergrund + col, 1.0);
}
