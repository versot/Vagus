<p align="center">
  <img src="packages/desktop/src-tauri/icons/vagus-logo.png" alt="Logo do Vagus" width="88" />
</p>

<h1 align="center">Vagus</h1>

<p align="center">
  <strong>Um espaço de trabalho para os agentes que você já usa</strong><br />
  Reúna projetos, conversas, atividade dos agentes e alterações no código.
</p>

<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.es.md">Español</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · Português (Brasil) · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <a href="README.ru.md">Русский</a> · <a href="README.vi.md">Tiếng Việt</a></p>

<p align="center">
  <img src="https://img.shields.io/badge/Beta%20build-Windows%20%7C%20macOS-4477ee" alt="Alvos de build Beta: Windows e macOS" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-3da683" alt="Licença: Apache-2.0" /></a>
  <img src="https://img.shields.io/badge/Stage-Beta%20testing-e9a23b" alt="Testes Beta" />
</p>

<p align="center">
  <img src="assets/screenshots/vagus-turn-changes-showcase.png" alt="Revisar alterações e diferenças do agente no Vagus" width="1000" />
</p>

<p align="center"><sub>Conversa e alterações de arquivos lado a lado.</sub></p>

## Um espaço de trabalho para seus agentes

O Vagus reúne projetos e conversas com agentes em um único espaço de trabalho. Escolha um agente, acompanhe o trabalho em tempo real, revise alterações em arquivos ao lado da conversa e retome sessões anteriores quando precisar. As CLIs, contas e modelos dos agentes continuam configurados na sua máquina.

## Recursos

- **Escolha o agente certo para a tarefa.** Use Pi, Claude Code, Codex, OpenCode, Qoder CLI ou ZCode no mesmo projeto, com os modelos e modos disponíveis em cada integração.
- **Acompanhe o processo.** Veja respostas em tempo real, atividade das ferramentas e estado de execução na conversa.
- **Revise alterações no contexto.** Confira os arquivos modificados em cada turno e abra o diff completo ao lado da conversa.
- **Mantenha as ferramentas por perto.** Abra abas de arquivos, terminal, navegador e revisão no espaço de trabalho.
- **Retome o trabalho anterior.** Pesquise conversas e importe o histórico nativo dos agentes compatíveis.
- **Agende tarefas recorrentes.** Crie tarefas locais agendadas e escolha agente, modelo e modo disponíveis para cada uma.

<p align="center">
  <img src="assets/screenshots/vagus-agent-picker-showcase.png" alt="Selecionar um agente para uma nova conversa no Vagus" width="1000" />
</p>

<p align="center"><sub>Escolha um agente ao iniciar uma conversa.</sub></p>

### Agentes integrados

| Agente | Integração | Observações |
| --- | --- | --- |
| Pi | Pi RPC | Mantém interações com extensões do Pi e importação nativa de conversas. |
| Claude Code | Ponte ACP | A CLI local do Claude Code gerencia instalação, login e configuração. |
| Codex | Codex app-server | Usa a CLI local do Codex; o app-server ainda é uma interface experimental. |
| OpenCode | ACP | Usa os recursos de sessão expostos pela CLI local do OpenCode. |
| Qoder CLI | ACP | Usa os recursos expostos pela CLI local do Qoder. |
| ZCode | Ponte ACP | Conecta-se pelo `zcode-acp-server`, mantido pela comunidade; não é uma integração ACP oficial da Z.ai. |

As ferramentas oficiais de cada agente gerenciam instalação, conta e configuração de modelos. O Vagus não faz login por você nem garante recursos que o agente não exponha pelo protocolo de integração.

## Plataformas

O Vagus está se preparando para a fase Beta e ainda não publicou o primeiro instalador. O fluxo de lançamento está configurado para Windows x64 e macOS Intel e Apple silicon. Não há assinatura de código nem notarização do macOS configuradas, e os pacotes para macOS ainda não passaram pela validação de lançamento. Linux não é compatível no momento.

## Versões Beta e downloads

As versões públicas de teste serão publicadas como GitHub Pre-releases, com números como `0.1.0-beta.1`. Cada página de lançamento terá instaladores, notas da versão e problemas conhecidos. Faça backup dos dados importantes antes de testar e informe a versão do Vagus e o sistema operacional ao relatar um problema.

O aplicativo desktop usa o Node.js local para executar o Vagus Host e requer Node.js 22.13 ou posterior. Cada usuário instala, configura e faz login nas CLIs dos agentes que precisar. Os instaladores não incluem Node.js nem as CLIs dos agentes.

Cada versão tem suas próprias notas em [`releases/`](releases/); o mesmo arquivo Markdown é usado como descrição do GitHub Release. Nenhum instalador Beta foi publicado ainda.

### Requisitos

- Windows de 64 bits
- Node.js 22.13 ou posterior e npm
- Rust stable, ferramentas de build C++ do MSVC e Windows SDK
- Microsoft Edge WebView2 Runtime

Na raiz do repositório, inicie o aplicativo de desenvolvimento:

```powershell
npm ci
npm run dev
```

Para gerar o instalador desktop:

```powershell
npm run build:desktop
```

### Verificar alterações

```powershell
npm run test:stage-one
npm run build:app
cargo test --locked --manifest-path packages/desktop/src-tauri/Cargo.toml
```

As verificações automatizadas rodam atualmente no CI do Windows. Um CI aprovado não significa que todas as versões de agentes, configurações de máquina ou plataformas foram validadas de ponta a ponta.

## Contribuição

Relatos de bugs e sugestões de melhoria são bem-vindos. Leia o [guia de contribuição](CONTRIBUTING.md) e use os [modelos de issue](.github/ISSUE_TEMPLATE/) ou o [modelo de pull request](.github/PULL_REQUEST_TEMPLATE.md). Antes de enviar imagens, ícones, fontes, código ou documentação, confirme que a redistribuição é permitida e informe a origem e a licença.

## Licença

O código original do Vagus é licenciado sob a [Apache License 2.0](LICENSE). Dependências e recursos mantêm as licenças de seus respectivos projetos de origem. As marcas dos agentes pertencem aos respectivos titulares e não são licenciadas pelo Vagus.
