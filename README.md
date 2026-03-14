# WA Discord Bot v3

## Variables d'environnement Railway

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Token de ton bot Discord |
| `CLIENT_ID` | ID de l'application Discord (pas le bot, l'app) |
| `PORT` | Automatique sur Railway |

> `DISCORD_CHANNEL_ID` n'est plus nécessaire, tout se configure via `/panel`

## Volume Railway (IMPORTANT)
Mount path : `/app/.wa_auth`  
Sans ça, la session WhatsApp est perdue à chaque redémarrage !

## Mise en route

1. Déploie sur Railway + volume configuré
2. Ouvre l'URL Railway → scanne le QR WhatsApp
3. Sur Discord, tape `/panel` → clique **Lister groupes WA**
4. Copie l'ID du groupe voulu
5. Tape `!map <ID_GROUPE> <ID_SALON_DISCORD>` pour lier

## Commandes Discord

| Commande | Description |
|---|---|
| `/panel` | Panneau de config (groupes, contacts, état) |
| `/send <destination> <message>` | Envoyer un message WA (numéro, contact ou groupe) |
| `/contact add <nom> <+33...>` | Ajouter un contact |
| `/contact list` | Lister les contacts |
| `/contact remove <nom>` | Supprimer un contact |
| `!map <waId> <dcId>` | Lier un groupe WA à un salon Discord |
| `!unmap <waId>` | Délier un groupe |

## Trouver CLIENT_ID
Discord Developer Portal → ton app → onglet "General Information" → Application ID
