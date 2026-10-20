import AppIntents

/// 1.65.0 (Owner 20.10.: „Weg 1 wie empfohlen“) — App-Intents-Erweiterung für den Fokusfilter. Apple (WWDC22 „Meet Focus
/// filters“): läuft die App, wird perform in der App aufgerufen; läuft sie nicht, startet iOS diese Erweiterung. Belegt am 20.10.:
/// ohne Erweiterung kam nur ein Aufruf (13:38, App lief), beim Umschalten mit geschlossener App nie. Der Filter selbst
/// (Runner/FokusFilter.swift) und der Netz-Code (Gemeinsam/AlfredNetz.swift) sind in App und Erweiterung dieselben Dateien.
@main
struct AlfredFokusErweiterung: AppIntentsExtension {}
