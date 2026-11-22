# 🏆 Quiz Battle – selbst gehostete Live-Quizshow

Web-App für **2 bis 4 Teams**, jeweils ein iPad/Tablet pro Team und ein Show-Bildschirm. Moderation über eigene Browser-Ansicht. **Kein Cloud-Dienst für den Spielbetrieb nötig.**

## Features

- **Multiple Choice**: 2–6 Antworten, eine ist richtig.
- **Richtige Reihenfolge**: Team sortiert mit großen Auf-/Ab-Pfeilen (auch iPad-Touch).
- **Buzzer-Battle**: Der erste Buzzer gewinnt die Runde der Wortmeldung. Moderation markiert die Antwort als richtig oder falsch; falsche Teams können nicht noch einmal buzzern, die anderen schon.
- **Schätzfragen**: Die kleinste absolute Abweichung gewinnt (Gleichstände zählen gemeinsam).
- **Live-Show**: Punktestand und farbige Richtig-/Falsch-Anzeige nach der Auflösung, Zeitring, Sounds, Spannungsmusik (synthetisch im Browser), Animationen, Konfetti und Podest.
- **Zwei Designs**: Standard und Sternsinger.
- **Moderation**: Bearbeiten/Hinzufügen/Löschen, Fragetyp, Antwortoptionen, Zeitlimit, Punkte, Start, Auflösung, Siegerehrung, Import/Export von Fragen (JSON).
- **Vollbild**: Button auf Show-/Team-/Moderationsbildschirm; eventuell vom Browser eingeschränkt.
- **Keine Scrollbars auf Show- und Teamansicht**: Layout passt sich Bildschirmgröße an; sehr lange Inhalte sollten trotzdem vermieden werden.
- **Dauerhafte Daten**: Fragen, Teamnamen, Punkte und Einstellungen im Docker-Volume.

## A) GitHub + Portainer (empfohlen)

1. Neues GitHub-Repository anlegen, z. B. `quiz-battle`. **Alle Dateien dieses Projekts** ins Repository hochladen; Standard-Branch `main`.
2. Unter **Actions** den Workflow `Docker-Image für Portainer` ausführen/abwarten. Er baut und veröffentlicht `ghcr.io/DEIN-NAME/quiz-battle:latest` (beim Organisations-Repository: `ghcr.io/ORG/REPO:latest`).
3. Bei GitHub unter **Packages → Package settings → Change visibility** das Container-Package auf **Public** setzen, damit Portainer es ohne Registry-Login abrufen kann. Alternativ eine GHCR-Registry in Portainer mit passenden Rechten konfigurieren.
4. In **Portainer → Stacks → Add stack → Repository** das GitHub-Repository eintragen, Compose-Pfad: `compose.yml`, Branch `main`.
5. In Portainer unter **Environment variables** festlegen:
   - `QUIZ_IMAGE` = `ghcr.io/DEIN-NAME/quiz-battle:latest` (genau wie in GitHub Packages, gewöhnlich Kleinbuchstaben)
   - `ADMIN_KEY` = ein **langes, geheimes Passwort** (kein Standard-PIN)
   - optional `QUIZ_PORT` = `1821` (Standard; bei Bedarf anpassen)
6. **Deploy the stack**. In Portainer bei GitOps optional automatische Updates/Repository-Polling aktivieren. Bei einem Update wird ein frisches Image aus GHCR geladen.

**Hinweis:** Der Image-Build findet via GitHub Actions statt. Daher benötigt Portainer keinen lokalen Build-Kontext. GitHub Actions muss Schreibrechte auf Packages erhalten; der Workflow fordert `packages: write` an.

## B) Lokal mit Docker Compose

```bash
cp .env.example .env
# .env: ADMIN_KEY auf ein sicheres Passwort ändern
# Einmalig im Projektordner:
docker compose -f compose.local.yml up -d --build
```

## Bildschirme und Links

Ersetze `SERVER-IP` durch die LAN-IP deines Docker-Servers und ggf. den Port:

- Startseite: `http://SERVER-IP:1821/`
- Show/Beamer: `http://SERVER-IP:1821/?view=show`
- Moderator: `http://SERVER-IP:1821/?view=mod`
- Team 1: `http://SERVER-IP:1821/?view=team&team=1`
- Teams 2–4: jeweils `team=2`, `team=3`, `team=4`

**iPad:** Alle Geräte benötigen Netzwerkzugriff auf die Server-IP. Im Moderatorbereich können Team-Links kopiert werden. Für die Show auf Vollbild klicken. Auf iPadOS kann der Safari-Vollbild-Button je nach Browser-/OS-Version eingeschränkt sein; „Zum Home-Bildschirm“ hinzufügen hilft mit einer app-artigen Darstellung. Sounds setzen eine Nutzerinteraktion (Klick/Touch) voraus – das ist eine Browser-Sicherheitsregel. Auf dem Show-Bildschirm einmal antippen, um Sound freizuschalten.

## Spielablauf

1. Im Moderatorbereich Teamanzahl, Teamnamen, Design und Musik einstellen; speichern.
2. Fragen bearbeiten oder neu anlegen; je Frage den ▶-Knopf drücken.
3. Teams antworten auf ihren iPads; bei Buzzerfragen antwortet das Gewinner-Team mündlich und die Moderation bestätigt oder verwirft.
4. **Auflösen** zeigt auf der Showkarte jedes Teams **grün/richtig** oder **rot/falsch**, den eigenen Tipp, sobald aufgelöst wurde, sowie die Punkte. Der Server berechnet die Punktvergabe genau einmal.
5. Weitere Fragen starten oder **Siegerehrung** mit Konfetti und Rangpodest öffnen.
6. Für einen neuen Wettkampf **Neues Spiel / Punkte zurücksetzen**.

## Sicherheits- und Betriebs-Hinweise

- Die Moderation ist durch `ADMIN_KEY` geschützt. Team-URLs sind **nicht** durch ein Passwort geschützt; verwende die App bevorzugt im vertrauenswürdigen lokalen Netz (LAN) oder über abgesichertes HTTPS mit Zugriffskontrollen/VPN.
- Wenn du die App öffentlich über das Internet zugänglich machst, verwende einen HTTPS-Reverse-Proxy und zusätzliche Zugriffskontrollen. Team-IDs sind keine echte Authentifizierung.
- Bei einem Browser-Reload bleiben Fragen und Punkte erhalten, die gerade gewählte Antwort **vor dem Absenden** jedoch nicht. Serverzustand liegt in `/app/data/state.json`.
- Regelmäßig das Docker-Volume `quiz_data` sichern; Backups sind bei Updates sinnvoll.
- Starterfragen sind Demo-Inhalte. Exportiere deine Fragen vor größeren Änderungen als JSON.
- Für das Timing wird die **Serveruhr** verwendet. Die Ablaufzeit gilt auch dann, wenn der Browser kurz die Verbindung verliert.
- Healthcheck-Endpunkt: `GET /health`.

## Technologie

Node.js 22, Express, Socket.IO, pures HTML/CSS/JavaScript, WebAudio-API, Docker, GitHub Actions, GHCR, Docker Compose. Keine Datenbank und keine externen APIs für den Spielbetrieb erforderlich.
