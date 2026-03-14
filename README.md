# WA Discord Bot v4 — Multi-sessions

## Variables Railway
| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Token bot Discord |
| `CLIENT_ID` | Application ID Discord |

## Volume Railway
Mount path : `/app/.wa_auth`

## Structure des sessions
```
/app/.wa_auth/
├── main/          ← Session principale du bot
├── sessions/
│   ├── 123456789/ ← Session Discord user 123456789
│   └── 987654321/ ← Session Discord user 987654321
└── bot_config.json
```

## Commandes
| Commande | Qui peut l'utiliser | Description |
|---|---|---|
| `/panel` | Tout le monde | Tableau de bord complet |
| `/connect +33...` | Tout le monde | Lier son compte WA |
| `/disconnect` | Tout le monde | Délier son compte WA |
| `/status` | Tout le monde | Voir son état WA |
| `/send dest message` | Membres connectés | Envoyer un message WA |
| `/contact add/list/remove` | Tout le monde | Gérer contacts |
| `!map waId dcId` | Admin | Lier groupe manuellement |
| `!unmap waId` | Admin | Délier groupe |

## Flux member
1. `/connect +33612345678`
2. Ouvrir WA → Paramètres → Appareils liés → Lier avec numéro
3. Entrer le code affiché → Connecté !
4. Écrire dans le salon Discord lié → message envoyé depuis ton WA
5. Messages WA reçus → apparaissent automatiquement dans Discord
