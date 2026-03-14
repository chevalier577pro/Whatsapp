# WA Discord Bot v2

Pont entre WhatsApp et Discord via Baileys.

## Variables d'environnement Railway

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Token de ton bot Discord |
| `DISCORD_CHANNEL_ID` | ID du salon Discord |
| `PORT` | Automatique sur Railway |

## Utilisation

- Ouvre l'URL de ton service Railway → scanne le QR avec WhatsApp
- Les messages WA arrivent dans Discord automatiquement
- Depuis Discord : `!wa +33612345678 Salut !` pour envoyer un message WA

## Reset session

Si WA se déconnecte en boucle → va sur `TON_URL_RAILWAY/reset`
