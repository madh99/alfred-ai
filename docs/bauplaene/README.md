# Bauplan-Vorlagen

Die mitgelieferten Bauplan-Vorlagen liegen im Code, nicht hier:

- `packages/core/src/infrastruktur/bauplan/vorlagen/pki_lab.ts` — PKI-Lab (isoliertes TLS-Negativtest-Lab: Aufbau, Test, Abbau)
- Register: `packages/core/src/infrastruktur/bauplan/vorlagen/index.ts` (`EINGEBAUTE_VORLAGEN`)

Speichern ohne Abschreiben des JSON: Skill `bauplan`, Aktion `bauplan_speichern` mit `eingebaut: "pki_lab"`.
Die eingebaute Vorlage durchläuft dieselbe volle Prüfung (Schema, Platzhalter, Geheimnisse, Probe) und wird als neue
Version (Entwurf) gespeichert; anwenden erst nach der Owner-Freigabe.
