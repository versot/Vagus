<p align="center">
  <img src="packages/desktop/src-tauri/icons/vagus-logo.png" alt="Logo Vagus" width="88" />
</p>

<h1 align="center">Vagus</h1>

<p align="center">
  <strong>Un espace de travail pour les agents que vous utilisez déjà</strong><br />
  Réunissez projets, conversations, activité des agents et modifications du code.
</p>

<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.es.md">Español</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.pt-BR.md">Português (Brasil)</a> · Français · <a href="README.de.md">Deutsch</a> · <a href="README.ru.md">Русский</a> · <a href="README.vi.md">Tiếng Việt</a></p>

<p align="center">
  <img src="https://img.shields.io/badge/Beta%20build-Windows%20%7C%20macOS-4477ee" alt="Cibles de build Beta : Windows et macOS" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-3da683" alt="Licence : Apache-2.0" /></a>
  <img src="https://img.shields.io/badge/Stage-Beta%20testing-e9a23b" alt="Tests Beta" />
</p>

<p align="center">
  <img src="assets/screenshots/vagus-turn-changes-showcase.png" alt="Examiner les modifications d’un agent et les différences dans Vagus" width="1000" />
</p>

<p align="center"><sub>La conversation et ses modifications de fichiers, côte à côte.</sub></p>

## Un espace de travail pour vos agents

Vagus réunit projets et conversations avec les agents dans un même espace de travail. Choisissez un agent, suivez son travail en direct, examinez les modifications de fichiers à côté de la conversation et reprenez vos sessions précédentes. Les CLI, comptes et modèles des agents restent configurés sur votre machine.

## Fonctionnalités

- **Choisissez l’agent adapté.** Utilisez Pi, Claude Code, Codex, OpenCode, Qoder CLI ou ZCode dans un même projet, avec les modèles et modes proposés par chaque intégration.
- **Suivez le travail en cours.** Consultez les réponses en direct, les outils utilisés et l’état d’exécution dans la conversation.
- **Examinez les modifications en contexte.** Retrouvez les fichiers modifiés à chaque tour et ouvrez le diff complet à côté de la conversation.
- **Gardez vos outils à portée de main.** Ouvrez des onglets de fichiers, terminal, navigateur et revue dans l’espace de travail.
- **Reprenez là où vous en étiez.** Recherchez des conversations et importez l’historique natif des agents compatibles.
- **Planifiez les tâches récurrentes.** Créez des tâches locales programmées avec l’agent, le modèle et le mode disponibles de votre choix.

<p align="center">
  <img src="assets/screenshots/vagus-agent-picker-showcase.png" alt="Choisir un agent pour une nouvelle conversation dans Vagus" width="1000" />
</p>

<p align="center"><sub>Choisissez un agent au début d’une conversation.</sub></p>

### Agents intégrés

| Agent | Intégration | Remarques |
| --- | --- | --- |
| Pi | Pi RPC | Préserve les interactions avec les extensions Pi et l’import natif des conversations. |
| Claude Code | Pont ACP | La CLI locale de Claude Code gère l’installation, la connexion et la configuration utilisateur. |
| Codex | Codex app-server | Utilise la CLI locale Codex ; app-server reste une interface expérimentale. |
| OpenCode | ACP | Utilise les capacités de session exposées par la CLI locale OpenCode. |
| Qoder CLI | ACP | Utilise les capacités exposées par la CLI locale Qoder. |
| ZCode | Pont ACP | Se connecte via `zcode-acp-server`, maintenu par la communauté ; il ne s’agit pas d’une intégration ACP officielle de Z.ai. |

Les outils officiels de chaque agent gèrent son installation, son compte et sa configuration de modèles. Vagus ne se connecte pas à votre place et ne garantit pas les fonctions que l’agent n’expose pas via son protocole d’intégration.

## Plateformes

Vagus prépare sa phase Beta et n’a pas encore publié son premier installateur. Le workflow de publication est configuré pour Windows x64 et macOS Intel et Apple silicon. La signature du code et la notarisation macOS ne sont pas configurées, et les paquets macOS n’ont pas passé la validation de publication. Linux n’est pas pris en charge actuellement.

## Versions Beta et téléchargements

Les versions de test publiques seront publiées en GitHub Pre-release avec des numéros tels que `0.1.0-beta.1`. Chaque page de version présentera les installateurs, les notes de version et les problèmes connus. Sauvegardez vos données importantes avant de tester et indiquez la version de Vagus et votre système d’exploitation lors d’un signalement.

Téléchargements prévus :

L’application de bureau utilise Node.js local pour exécuter Vagus Host et nécessite Node.js 22.13 ou une version ultérieure. Chaque utilisateur installe, configure et connecte les CLI des agents dont il a besoin. Les installateurs n’incluent ni Node.js ni les CLI des agents.

Chaque version possède ses propres notes dans [`releases/`](releases/) ; ce fichier Markdown sert également de description au GitHub Release. Aucun installateur Beta n’a encore été publié.

### Prérequis

- Windows 64 bits
- Node.js 22.13 ou version ultérieure et npm
- Rust stable, outils de build C++ MSVC et Windows SDK
- Microsoft Edge WebView2 Runtime

Depuis la racine du dépôt, démarrez l’application de développement :

```powershell
npm ci
npm run dev
```

Pour générer l’installateur de bureau :

```powershell
npm run build:desktop
```

### Vérifier les modifications

```powershell
npm run test:stage-one
npm run build:app
cargo test --locked --manifest-path packages/desktop/src-tauri/Cargo.toml
```

Les contrôles automatisés s’exécutent actuellement sur le CI Windows. Un CI réussi ne signifie pas que toutes les versions d’agents, configurations machine et plateformes ont été validées de bout en bout.

## Contribuer

Les rapports de bugs et suggestions d’amélioration sont les bienvenus. Lisez le [guide de contribution](CONTRIBUTING.md) et utilisez les [modèles d’issue](.github/ISSUE_TEMPLATE/) ou de [pull request](.github/PULL_REQUEST_TEMPLATE.md). Avant d’envoyer des images, icônes, polices, du code ou de la documentation, vérifiez les droits de redistribution et indiquez la source et la licence.

## Licence

Le code original de Vagus est sous [Apache License 2.0](LICENSE). Les dépendances et ressources restent soumises aux licences de leurs projets d’origine. Les marques des agents appartiennent à leurs titulaires respectifs et ne sont pas couvertes par la licence Vagus.
