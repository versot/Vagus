<p align="center">
  <img src="packages/desktop/src-tauri/icons/vagus-logo.png" alt="Logotipo de Vagus" width="88" />
</p>

<h1 align="center">Vagus</h1>

<p align="center">
  <strong>Un espacio de escritorio para los agentes que ya usas</strong><br />
  Reúne proyectos, conversaciones, actividad de agentes y cambios de código.
</p>

<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · Español · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.pt-BR.md">Português (Brasil)</a> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <a href="README.ru.md">Русский</a> · <a href="README.vi.md">Tiếng Việt</a></p>

<p align="center">
  <img src="https://img.shields.io/badge/Beta%20build-Windows%20%7C%20macOS-4477ee" alt="Objetivos de compilación Beta: Windows y macOS" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-3da683" alt="Licencia: Apache-2.0" /></a>
  <img src="https://img.shields.io/badge/Stage-Beta%20testing-e9a23b" alt="Pruebas Beta" />
</p>

<p align="center">
  <img src="assets/screenshots/vagus-turn-changes.png" alt="Revisar cambios y diferencias de un agente en Vagus" width="1000" />
</p>

<p align="center"><sub>La conversación y sus cambios de archivos, uno al lado del otro.</sub></p>

## Un espacio de trabajo para tus agentes

Vagus reúne proyectos y conversaciones con agentes en un mismo espacio de escritorio. Elige un agente, sigue su trabajo en directo, revisa los cambios de archivos junto a la conversación y retoma sesiones anteriores cuando lo necesites. Las CLI, cuentas y modelos de los agentes siguen configurados en tu equipo.

## Funciones

- **Elige el agente adecuado.** Usa Pi, Claude Code, Codex, OpenCode, Qoder CLI o ZCode en el mismo proyecto, con los modelos y modos que ofrece cada integración.
- **Sigue el proceso, no solo la respuesta.** Ve las respuestas en tiempo real, la actividad de las herramientas y el estado de ejecución en la conversación.
- **Revisa los cambios en contexto.** Consulta los archivos modificados en cada turno y abre el diff completo junto a la conversación.
- **Ten las herramientas a mano.** Abre pestañas de archivos, terminal, navegador y revisión en el espacio de escritorio.
- **Retoma el trabajo anterior.** Busca conversaciones e importa historiales nativos de los agentes que lo permiten.
- **Programa tareas repetitivas.** Crea tareas locales programadas y elige el agente, modelo y modo disponibles para cada una.

<p align="center">
  <img src="assets/screenshots/vagus-agent-picker-detail.svg" alt="Seleccionar un agente para una nueva conversación en Vagus" width="1000" />
</p>

<p align="center"><sub>Elige un agente al iniciar una conversación.</sub></p>

### Agentes integrados

| Agente      | Integración      | Notas                                                                                                          |
| ----------- | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| Pi          | Pi RPC           | Conserva las interacciones con extensiones de Pi y la importación nativa de conversaciones.                    |
| Claude Code | Puente ACP       | La CLI local de Claude Code gestiona instalación, inicio de sesión y configuración.                            |
| Codex       | Codex app-server | Usa la CLI local de Codex; app-server sigue siendo una interfaz experimental.                                  |
| OpenCode    | ACP              | Usa las capacidades de sesión expuestas por la CLI local de OpenCode.                                          |
| Qoder CLI   | ACP              | Usa las capacidades expuestas por la CLI local de Qoder.                                                       |
| ZCode       | Puente ACP       | Se conecta mediante `zcode-acp-server`, mantenido por la comunidad; no es una integración ACP oficial de Z.ai. |

Las herramientas oficiales de cada agente gestionan su instalación, cuenta y modelos. Vagus no inicia sesión por ti ni garantiza funciones que el agente no exponga mediante su protocolo de integración.

## Plataformas

Vagus está en fase Beta pública. La primera versión ofrece instaladores para Windows x64, macOS Intel y Apple silicon. No se han configurado la firma de código ni la notarización de macOS, y los paquetes de macOS no han superado la validación de lanzamiento. Linux no está soportado actualmente.

## Versiones Beta y descargas

La primera versión pública de prueba está disponible en [Vagus v0.1.0-beta.1](https://github.com/versot/Vagus/releases/tag/v0.1.0-beta.1). Cada página de GitHub Pre-release incluye instaladores, notas y problemas conocidos. Haz una copia de seguridad de tus datos antes de probarla e incluye la versión de Vagus y tu sistema operativo al informar de un problema.

La aplicación de escritorio usa Node.js local para ejecutar Vagus Host y requiere Node.js 22.13 o posterior. Cada usuario instala, configura e inicia sesión en las CLI de los agentes que necesite. Los instaladores no incluyen Node.js ni las CLI de los agentes.

Cada versión tiene sus propias notas en [`releases/`](releases/); ese mismo archivo Markdown se utiliza como descripción de GitHub Release.

### Requisitos

- Windows de 64 bits
- Node.js 22.13 o posterior y npm
- Rust stable, herramientas de compilación C++ de MSVC y Windows SDK
- Microsoft Edge WebView2 Runtime

Desde la raíz del repositorio, inicia la aplicación de desarrollo:

```powershell
npm ci
npm run dev
```

Para compilar el instalador:

```powershell
npm run build:desktop
```

### Verificar cambios

```powershell
npm run test:stage-one
npm run build:app
cargo test --locked --manifest-path packages/desktop/src-tauri/Cargo.toml
```

Las comprobaciones automatizadas se ejecutan actualmente en Windows CI. Que CI pase no significa que todas las versiones de agentes, configuraciones de equipo o plataformas se hayan validado de extremo a extremo.

## Contribuir

Se agradecen los informes de errores y las propuestas de mejora. Lee la [guía de contribución](CONTRIBUTING.md) y utiliza las [plantillas de incidencias](.github/ISSUE_TEMPLATE/) o la [plantilla de pull request](.github/PULL_REQUEST_TEMPLATE.md). Antes de enviar imágenes, iconos, fuentes, código o documentación, confirma que se pueden redistribuir e indica su origen y licencia.

## Licencia

El código original de Vagus se publica bajo la [Apache License 2.0](LICENSE). Las dependencias y los recursos conservan las licencias de sus respectivos proyectos de origen. Las marcas de los agentes pertenecen a sus respectivos titulares y no están cubiertas por la licencia de Vagus.
