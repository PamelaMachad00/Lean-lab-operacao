# Lean Lab Operação

Digitalização de um laboratório de Manufatura Enxuta (UniSenai / Renault do Brasil): leitura de etiquetas por QR Code, painel de indicadores em tempo real e relatório automático de rodada — sem planilha, sem papel.

Front-end em **HTML/CSS/JavaScript puro** (ES Modules, sem framework, sem build step) com banco de dados em tempo real no **Firebase (Firestore)**, e um fallback local automático pra rodar e testar sem nenhuma configuração.

## Sobre o projeto

Num laboratório de Manufatura Enxuta, cada posto de trabalho tem um tempo de ciclo esperado (definido na Folha de Operação Standard — FOS) e o instrutor precisa acompanhar, em tempo real, se a linha está dentro do padrão, qual posto está represando a produção (o "posto restritivo") e onde estão os pontos de retrabalho e anomalias.

Este app substitui a coleta manual: o operador escaneia o QR Code da etiqueta do seu posto, o app calcula o tempo de ciclo e registra o resultado (concluído, retrabalho ou anomalia 5S) no banco de dados. O painel, o relatório da rodada e os indicadores atualizam sozinhos, pra todo mundo que estiver com a página aberta, sem precisar recarregar.

## Funcionalidades

- Entrada por QR Code, dois jeitos: escaneando de dentro do app (câmera + biblioteca de leitura) ou apontando a câmera nativa do celular direto pra etiqueta impressa, que abre o link e já reconhece o posto.
- Painel da linha com o posto restritivo, aderência à FOS, lead time estimado, WIP (estoque em processo) e retrabalho, todos calculados a partir das leituras gravadas — nenhum número é digitado à mão.
- Relatório da rodada com gráficos de tendência (aderência e lead time ao longo do tempo) e uma narrativa gerada automaticamente a partir dos indicadores.
- Geração e download de etiquetas QR Code por posto, prontas pra imprimir.
- Cadastro de pessoas por posto — o nome já aparece sugerido pro operador quando ele escaneia a etiqueta.
- Login de coordenador(a) com senha (hash SHA-256 + salt, sem depender de servidor) e um fluxo de entrada separado, mais simples, pro operador.
- Sincronização em tempo real entre todos os aparelhos conectados via Firebase Firestore, com fallback automático pra um banco local (`localStorage`) quando o Firebase não está configurado.

## Arquitetura

```
lean-lab-operacao/
├── index.html              → estrutura da página (sem estilo nem lógica)
├── css/
│   └── styles.css          → todo o visual (paleta Renault/UniSenai, layout responsivo)
├── js/
│   ├── config.js           → dados de referência: postos, FOS, takt time, baseline
│   ├── firebase-config.js  → credenciais do projeto Firebase (você preenche)
│   ├── db.js                → camada de banco: Firestore real + fallback local, mesma interface pros dois
│   ├── indicators.js       → cálculo dos indicadores — funções puras, testadas isoladamente
│   └── app.js               → estado, autenticação, câmera/QR, renderização, navegação
├── tests/
│   └── indicators.test.js  → testes unitários (Vitest) da camada de indicadores
└── .github/workflows/
    └── tests.yml            → roda os testes automaticamente a cada push
```

### Decisões técnicas

**Por que só um módulo grande (`app.js`) e não vários pequenos?** As telas deste app são fortemente acopladas ao DOM: cada função de renderização lê e escreve em vários elementos ao mesmo tempo, e o estado (usuário logado, leituras, câmera ligada) é compartilhado entre quase todas elas. Fatiar isso em módulos menores só ia trocar acoplamento por import/export sem tornar nada mais testável de verdade. Em vez disso, separei o que **é** naturalmente independente — dados de referência (`config.js`), acesso ao banco (`db.js`) e cálculo de indicadores (`indicators.js`) — e deixei a orquestração de UI concentrada em `app.js`, com um objeto `state` único em vez de variáveis soltas no escopo do módulo.

**Por que as funções de `indicators.js` são puras?** Cada uma recebe o array de leituras como parâmetro (em vez de ler uma variável global) e devolve um valor, sem tocar no DOM. Isso é o que permite testá-las isoladamente em `tests/indicators.test.js` — dá pra verificar "essa fórmula está certa?" sem precisar simular clique, câmera ou banco de dados.

**Por que event delegation em vez de `onclick="..."` no HTML?** Com `<script type="module">`, funções declaradas no módulo não ficam automaticamente disponíveis em `window` — então atributos `onclick` inline parariam de funcionar. A solução (e a prática recomendada hoje em dia, é o que qualquer biblioteca de UI faz por baixo dos panos) é marcar os elementos com `data-action="..."` e escutar os cliques uma única vez, no `document`, despachando pra função certa. Também resolve um problema que já existia antes: HTML gerado dinamicamente (como os cards de posto) tinha lógica misturada com marcação.

**Por que Firestore, com fallback local?** A API do banco que o protótipo original já usava (`.collection().doc().get()/.set()/.onSnapshot()`) tinha praticamente a cara do SDK do Firestore — então adotar o Firestore de verdade exigiu pouquíssima mudança de código, e o app continua 100% funcional (num único navegador, sem sincronizar entre aparelhos) mesmo sem nenhuma configuração, o que ajuda muito na hora de testar.

## Stack

- HTML5, CSS3, JavaScript (ES2022+, ES Modules) — sem framework, sem bundler, sem build step.
- [Firebase Firestore](https://firebase.google.com/docs/firestore) (SDK compat) como banco de dados em tempo real.
- [qr-scanner](https://github.com/nimiq/qr-scanner) pra leitura de QR Code pela câmera.
- [qrcodejs](https://github.com/davidshimjs/qrcodejs) pra gerar os QR Codes das etiquetas.
- [Vitest](https://vitest.dev/) pros testes unitários.
- GitHub Actions pra integração contínua.

## Como rodar localmente

Não dá pra simplesmente abrir o `index.html` clicando duas vezes — isso desliga a câmera e quebra os links dos QR Codes (veja [Limitações conhecidas](#limitações-conhecidas)). Rode um servidor local:

```bash
git clone https://github.com/SEU-USUARIO/lean-lab-operacao.git
cd lean-lab-operacao
npm run dev
```

Isso sobe um servidor Python simples em `http://localhost:8000`. Sem o Firebase configurado, o app roda no modo local automaticamente — dá pra testar tudo (login, leitura de QR, indicadores) sem precisar de conta nenhuma.

## Deploy no GitHub Pages

1. Suba o repositório pro GitHub (pode ser público).
2. Vá em **Settings → Pages**. Em "Source", escolha a branch `main` e a pasta `/ (root)`. Salve.
3. Espere 1–2 minutos. O GitHub mostra um link tipo `https://seu-usuario.github.io/lean-lab-operacao/`.
4. Abra esse link no celular e confira que a câmera liga normalmente — é o teste de que está tudo publicado certo (câmera exige HTTPS ou `localhost`, então só funciona publicado ou rodando localmente, nunca em `file://`).

## Configurar o Firebase (Firestore)

O Firestore é o banco de dados que guarda de verdade as leituras, os cadastros de pessoas e os logins de coordenador, sincronizando entre todos os aparelhos que abrirem o link.

1. Acesse [console.firebase.google.com](https://console.firebase.google.com) e crie um projeto novo (gratuito, não pede cartão).
2. **Compilação → Firestore Database → Criar banco de dados.** Escolha uma região perto do Brasil (ex.: `southamerica-east1`) e comece em modo de teste.
3. **⚙️ Configurações do projeto → Geral → Seus apps →** ícone `</>` (Web) → registre um app. O Firebase mostra um objeto `firebaseConfig`.
4. Cole esses valores em `js/firebase-config.js`, substituindo o placeholder `'COLE_AQUI_SUA_API_KEY'` e os demais.
5. Suba o `js/firebase-config.js` atualizado pro GitHub. Abra o link publicado: o texto embaixo do botão "Entrar" deve mudar de "Modo local" para "Conectado ao Firebase".

Esses valores não são segredo — ficam visíveis pra qualquer um que olhar o código do site (é assim que o Firebase funciona no navegador). Quem protege os dados são as **Regras de segurança** do Firestore, configuradas no console:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}
```

> O login de coordenador deste app é uma senha caseira (hash), não a Autenticação do Firebase — então as regras não têm como reconhecer "quem é coordenador" pra restringir o acesso. Pra um laboratório com dados ilustrativos isso costuma ser aceitável, mas não é o ideal se um dia entrarem dados sensíveis de verdade; travar isso de vez passaria por integrar a Autenticação do Firebase.

## Testes

```bash
npm install
npm test
```

Os testes cobrem a camada de indicadores (`js/indicators.js`): médias, posto restritivo, aderência à FOS, WIP, lead time estimado e casos de borda (sem leituras, tudo dentro do padrão, etc.). Rodam automaticamente a cada push via GitHub Actions (`.github/workflows/tests.yml`).

## Limitações conhecidas

- **Câmera exige HTTPS ou `localhost`.** Abrir o `index.html` direto (`file://`) desliga a câmera — é bloqueio de segurança do navegador, não bug do código.
- **Sem Firebase configurado, os dados ficam só no navegador de cada aparelho** (não sincronizam entre celulares/computadores), mas sobrevivem a atualizar a página.
- **QR Codes** carregam um link (`.../index.html?posto=N`). Mudar a estrutura de pastas do site invalida etiquetas já impressas — gere e imprima etiquetas novas depois de qualquer mudança de endereço.

## Licença

[MIT](LICENSE) © 2026 Pamela da Silva Machado
