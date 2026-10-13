# Yoto-Integration

Diese Integration bringt den Zustand deiner **Yoto**-Player in Gladys:
Akku, Ladezustand, Lautstärke, laufende Karte, Umgebungslicht,
Gerätetemperatur, WLAN-Signal und Online-Status.

## Was du bekommst

Ein Gladys-Gerät pro Yoto-Player des Kontos, mit neun schreibgeschützten Sensoren.
Die öffentliche Yoto-API liefert die Telemetrie der Player, aber keine
Wiedergabebefehle (Wiedergabe, Pause, Lautstärke): Aus Gladys lässt sich also nichts
steuern — die Funktionen sind als schreibgeschützt deklariert, statt einen Knopf
anzuzeigen, der nichts bewirken würde.

Zusätzlich zu den Geräten: zwei Dashboard-Widgets, drei Szenen-Auslöser und zwei
Szenen-Aktionen (siehe unten).

## Voraussetzungen

Gladys Assistant **5.1** oder neuer.

Eine kostenlose App im Yoto-Entwicklerportal:

1. Öffne <https://dashboard.yoto.dev/> und erstelle eine App als **öffentlichen Client** (_public client_).
2. Aktiviere die Scopes `family:devices:view`, `family:devices:control`,
   `family:library:view` und `offline_access`.
3. Kopiere die **Client ID**.

Yoto hat den _Device-Code_-Flow abgekündigt: Die Integration verwendet den
Browser-Flow, den Yoto heute empfiehlt (Authorization Code + PKCE). Die App
benötigt daher auch die Gladys-Callback-URL in ihren **Allowed callback URLs** —
siehe unten.

## Konfiguration

1. Öffne den Tab **Konfiguration** der Integration.
2. Füge die **Yoto Client ID** ein und speichere.
3. Klicke ein erstes Mal auf **Verbinden** und öffne dann die Protokolle
   der Integration: Die Zeile
   `Yoto sign-in started, callback URL to allow on the Yoto app: …` nennt die
   genaue URL, die du in die **Allowed callback URLs** deiner Yoto-App einträgst.
4. Klicke erneut auf **Verbinden**: Melde dich auf der Yoto-Seite an,
   Yoto leitet zurück zu Gladys und das Verbindungsabzeichen wird grün.
5. Die Player erscheinen im Tab **Entdecken** und können hinzugefügt werden.

Einstellungen:

- **Aktualisierungsintervall** (`poll_frequency`) — 30 bis 3600 Sekunden,
  standardmäßig 120. So oft wird jeder Player ausgelesen. Die Yoto-API ist eine
  Cloud-API: Bleib über 60 Sekunden, sofern du nicht wirklich mehr brauchst.
  Gladys plant in festen Takten (höchstens 60 Sekunden): Ein Wert zwischen 30 und
  59 Sekunden läuft über den 30-Sekunden-Takt, alles über 60 Sekunden wird von der
  Integration selbst eingehalten. Eine Änderung gilt sofort, ohne dass ein Gerät
  neu angelegt werden muss.
- **Player vor dem Auslesen aktualisieren lassen** — sendet vor jeder Abfrage eine
  Statusanfrage an den Player, damit aktuelle Werte gelesen werden statt der
  zuletzt gemeldeten (die Integration wartet vor dem Auslesen eine Sekunde auf die
  Antwort des Players). Schalte die Option aus, wenn deiner Yoto-App der Scope
  `family:devices:control` fehlt.

Die Tokens werden von Gladys intern aufbewahrt (nie in der Oberfläche angezeigt):
Die Verknüpfung übersteht einen Neustart oder ein Image-Update.

## Aktionen

- **Verbindung testen** — fragt das Yoto-Konto ab und zeigt an, wie viele Player
  gefunden wurden, mit ihren Namen.
- **Alle Player jetzt aktualisieren** — fragt sofort jeden Player ab, ohne auf den
  nächsten Zyklus zu warten.

## Dashboard-Widgets

Erfordert Gladys 5.1 oder neuer. Füge sie unter **Dashboard → Bearbeiten → Neues Widget** hinzu:

- **Alle Yoto-Player** — alle Player des Kontos in einer Karte: die laufende Karte,
  der Akkustand (grün, orange unter 50 %, rot unter 20 %, ein ⚡ am Netz) und ob
  der Player online ist. Tippe auf eine Zeile für die Details (Lautstärke,
  Temperatur, Licht, WLAN).
- **Yoto-Player** — ein Player, in den Widget-Einstellungen ausgewählt: live
  aktualisierte Kacheln für Akku, Lautstärke und Temperatur, die Akkukurve der
  letzten 24 Stunden sowie Wiedergabe-, Stromversorgungs- und Verbindungsstatus.

Beide haben einen Knopf **Aktualisieren**, der die Player sofort ausliest. Die
Widgets werden aus der letzten Messung gezeichnet: Das Öffnen eines Dashboards
fragt Yoto nie ab.

## Szenen

Erfordert Gladys 5.1 oder neuer.

Auslöser (der Filter **Player** ist optional: leer bedeutet jeder Player):

- **Eine Karte startet auf einem Yoto-Player** — optionaler Filter auf den genauen
  Kartentitel. Variablen: Name des Players, Kartentitel, Karten-ID.
- **Ein Yoto-Player beendet die Wiedergabe** — Variablen: Name des Players, Titel
  und ID der Karte, die gespielt wurde.
- **Akku eines Yoto-Players schwach (unter 20 %)** — löst einmal aus, wenn der Akku
  unter 20 % fällt, während der Player nicht am Netz ist; löst erst nach einem
  Ladevorgang (oder wieder über 25 %) erneut aus. Variablen: Name des Players,
  Akkustand.

Ereignisse werden bei jeder Aktualisierung erkannt (standardmäßig alle 120 s), ein
Auslöser kann also bis zu einem Aktualisierungsintervall verspätet auslösen. Bei der
ersten Messung nach einem Neustart löst nichts aus.

Aktionen:

- **Yoto-Player auslesen** — liest den Player sofort aus und übergibt seine Werte an
  die nächsten Schritte: Name, online, Akku, am Netz, Lautstärke, Wiedergabe läuft,
  Kartentitel, Temperatur, WLAN-Signal. Praktisch für eine Bedingung („wenn der Akku
  unter 30 % liegt, eine Nachricht senden“) oder eine Nachricht
  („{{player_name}} spielt {{card_title}}“).
- **Alle Yoto-Player aktualisieren** — liest sofort jeden Player aus; gibt zurück,
  wie viele ausgelesen wurden.

Eine Karte starten, pausieren oder die Lautstärke aus Gladys ändern ist nicht
möglich: Die öffentliche Yoto-API bietet diese Befehle nicht an (sie laufen über
einen privaten Yoto-Kanal).

## Fehlerbehebung

- **Batteriestandswarnung („Battery below 10 % (current: 1 %)“), obwohl der
  Player geladen ist** — behoben nach 2.0.0: Die Funktion „Charging“ lag in der
  Akku-Kategorie, und die wöchentliche Prüfung von Gladys las sie als
  Prozentwert (1 = am Netz). Öffne nach dem Update den Tab **Entdecken** und
  klicke beim Player auf **Aktualisieren** (oder lösche ihn und füge ihn erneut
  hinzu), damit die Funktion in ihre neue Kategorie wechselt.
- **„Noch kein Yoto-Konto verknüpft: Klicke auf Verbinden.“** — die Client ID
  ist gesetzt, aber das Konto wurde nie verknüpft, oder die Verknüpfung ist
  abgelaufen.
- **„Die Yoto-Verknüpfung ist abgelaufen, bitte verbinde dein Konto erneut.“** —
  das Token wurde widerrufen (Passwortänderung, App auf Yoto-Seite gelöscht).
  Klicke erneut auf **Verbinden**. Ein Zugriffstoken, das Yoto vorzeitig
  ablehnt, wird zuerst einmal automatisch erneuert: Diese Meldung erscheint nur,
  wenn Yoto auch die Erneuerung ablehnt.
- **„Yoto-Dienst nicht erreichbar, prüfe die Protokolle der Integration.“** —
  ein Auslesen ist fehlgeschlagen (Yoto ausgefallen, Netzwerk unterbrochen). Nichts
  zu tun: Das Abzeichen wird beim nächsten erfolgreichen Auslesen wieder grün.
  Startet der Container, bevor das Netzwerk bereit ist, wird das Yoto-Konto nach
  1 Minute, nach 5 Minuten und dann alle 15 Minuten erneut gelesen, bis die Player
  im Tab **Entdecken** erscheinen.
- **Yoto antwortet „Callback URL mismatch“** — die auf dieser Yoto-Seite angezeigte
  URL ist der Gladys-Callback: Trage sie in die **Allowed callback URLs** deiner
  Yoto-App ein und klicke dann erneut auf **Verbinden**.
- **„Die Yoto-Anmeldung konnte nicht gestartet werden: …“** — der Grund steht in der
  Meldung und in den Protokollen. `unauthorized_client` am Device-Code-Endpunkt
  bedeutet, dass die Yoto-App keinen Device-Code-Grant hat: Yoto hat ihn
  abgekündigt, aktualisiere Gladys, damit der Browser-Flow verwendet wird.
- **„No Yoto sign-in is in progress“** — die Integration wurde zwischen dem Klick auf
  **Verbinden** und der Rückkehr von Yoto neu gestartet; klicke erneut auf
  **Verbinden**.
- **Veraltete oder fehlende Werte** — ein ausgeschalteter oder offline befindlicher
  Player meldet nichts: Die Integration behält den letzten bekannten Zustand, und
  der Sensor „Online“ fällt auf 0. Sensoren, die ein Modell nicht hat (zum Beispiel
  die Temperatur bei einem Yoto Mini), werden einfach nicht veröffentlicht.
- **401/403-Fehler in den Protokollen** — die Scopes deiner Yoto-App sind
  unvollständig. Prüfe sie im Entwicklerportal und verknüpfe das Konto
  dann erneut.

Die Integration protokolliert alles, was sie tut: Lies die Protokolle in der
Gladys-Oberfläche (oder mit `docker logs` auf dem Host) mit `LOG_LEVEL=debug` für
alle Details.
