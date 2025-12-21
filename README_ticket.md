Ticket-System Hinweise

- Kopiere `config.example.json` nach `config.json` und fülle die IDs aus:
  - `ticketCategoryId`: Kategorie-ID, in der Ticket-Kanäle erstellt werden
  - `logChannelId`: Kanal-ID, in den Erstellungs-/Schließ-Logs und Transkripte gesendet werden
  - `staffRoleId`: Rolle, die Tickets sehen/bearbeiten darf
  - `transcriptFolder`: Ordnername für gespeicherte Transkripte (Standard: `transcripts`)
  - `maxOpenPerUser`: maximale offene Tickets pro Nutzer (nicht strikt enforced neben Name/topic check)

Beispiele für Befehle / Verhalten:
- `/ticket` sendet das Ticket-Embed mit Select-Menu (Support, Bug, Bewerbung).
- Wählt ein Nutzer einen Typ, wird ein Kanal `ticket-<userid>` erstellt.
- Im Kanal gibt es einen "Close Ticket"-Button, der ein Modal zur Bestätigung öffnet.
- Beim Schließen wird ein Transkript (.txt + .html) im `transcripts`-Ordner erstellt und optional in `logChannelId` gepostet.

Installation / Start

1. Setze `DISCORD_TOKEN` in deiner Umgebung (.env) oder Umgebungsversion.
2. `npm install` (abhängig von bereits vorhandenen Paketen in `package.json`)
3. `node index.js`

Anmerkungen
- Diese Implementierung ist modular: Module liegen in `commands/` und `events/`.
- Passe `config.json` an deine Server-IDs an.
