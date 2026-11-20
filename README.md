# Perfil IA

**Descubra quem, o que ou qual lugar está escondido por trás das dicas!**

O jogador recebe uma carta misteriosa com dicas, da mais difícil para a mais fácil (as cartas criadas pela IA têm exatamente 20), e precisa adivinhar a resposta usando o menor número possível de dicas. A inteligência artificial (Claude, da Anthropic) cria cartas, gera dicas extras e monta desafios personalizados.

## Funcionalidades

| Funcionalidade | Como funciona |
| --- | --- |
| **20 temas nativos** | Futebol, Esportes, Ciência, Arte, Literatura, Música brasileira, Música do mundo, Maravilhas, Cidades do mundo, Natureza do Brasil, Países, Cidades brasileiras, Comidas, Festas, Objetos, Tecnologia, Animais, Espaço, Folclore e Mitologia. São 80 cartas prontas com 20 dicas cada, que funcionam sem IA e sem internet. Clique num tema ou em **🎲 Sortear tema**. |
| **Buscar na internet (sem IA)** | Digite qualquer assunto: o servidor lê o artigo da Wikipédia, transforma frases em dicas escondendo o nome e monta uma carta de 20 dicas. É grátis, não usa tokens, e cada tema tem 10 assuntos extras para gerar mais cartas com um clique. |
| **Partida individual** | Você joga contra a IA: abre dicas e chuta quando quiser. Acertar com 1 dica vale 10 pontos, com 10 dicas vale 1. Cada palpite errado abre mais uma dica. |
| **Multiplayer online** | Crie uma sala, compartilhe o código de 4 letras e jogue com até 8 amigos em tempo real. Na sua vez, você chuta ou pede mais uma dica; quem acertar primeiro leva os pontos da carta. |
| **Cartas inteligentes** | A IA cria uma carta com exatamente 20 dicas (categoria, tema e dificuldade à sua escolha). Se o banco já tem uma carta compatível que você ainda não jogou, ela é usada sem chamar a IA e sem custo. |
| **Categorias** | Pessoa, Lugar e Coisa vêm prontas; escolha "+ Nova categoria" e a IA cria uma (Animal, Filme, Comida…). |
| **Desafio personalizado** | Você escolhe um tema ("Copa do Mundo", "mitologia grega"…) e a IA monta uma sequência de 5 cartas. |
| **Dica extra** | Travou? A IA escreve uma dica extra, que fica salva e é reaproveitada para os próximos jogadores dessa carta (custa 1 ponto no acerto). |
| **Banco de cartas** | Todas as cartas, as clássicas e as criadas pela IA, ficam salvas no SQLite para todos jogarem, com estatísticas de acerto. A resposta nunca é enviada ao navegador antes do fim da partida. |
| **Sistema de tokens** | Créditos para usar os recursos de IA (veja abaixo). |

### Tokens

| Ação | Tokens |
| --- | --- |
| Boas-vindas | +20 |
| Bônus diário | +5 |
| Acertar usando até 3 dicas | +1 |
| Carta inteligente | −2 |
| Desafio personalizado (5 cartas) | −5 |
| Dica extra da IA | −1 |

Se a IA falhar ou gerar uma carta inválida, os tokens são devolvidos automaticamente. Os valores ficam em `TOKEN_RULES` (`server/db.js`).

## Regras da IA

As regras completas estão na skill `.claude/skills/perfil-ai/SKILL.md`. Resumo:

- **Validação antes de salvar** (`server/cards.js`): JSON bem formado, categoria presente, exatamente 20 dicas entre 12 e 160 caracteres, sem dicas repetidas e sem nenhuma dica que revele a resposta, um apelido ou uma palavra do nome (inclusive com erro de grafia). Carta inválida não é salva.
- **Sem duplicatas**: a resposta e os apelidos são normalizados (sem acento, sem artigo) e comparados com todo o banco.
- **Sem chamadas desnecessárias**: carta, desafio e dica extra procuram primeiro no banco.
- **Consumo real registrado**: cada chamada grava em `ai_usage` os tokens de entrada e saída, o modelo que respondeu, o custo em US$ e o resultado (ok, parcial, rejeitada, recusa, erro).
- **Controle de custo**: `max_tokens` limitado para que nenhuma geração passe de `AI_MAX_COST_PER_CALL_USD`, orçamento diário global `AI_DAILY_BUDGET_USD` e limite de pedidos por jogador `AI_USER_DAILY_LIMIT`. Tudo é verificado antes da chamada.
- **Chave só no backend**: o navegador e o APK nunca recebem a chave; o build do APK é cancelado se encontrar uma.

Relatório de consumo: `curl -H "x-admin-token: $ADMIN_TOKEN" http://localhost:3000/api/admin/usage?days=30`

## Como rodar

Requer **Node.js 22.13+** (o banco usa o módulo nativo `node:sqlite`).

```bash
npm install
npm run setup     # cola a chave da Anthropic (fica escondida), testa e salva no .env
npm start         # http://localhost:3000
```

### Chave da Anthropic

1. Crie uma chave em https://console.anthropic.com/settings/keys (é preciso ter créditos na conta).
2. No servidor, rode `npm run setup` e cole a chave. Ela não aparece na tela, é testada sem gastar tokens e é salva no `.env` com permissão só para o dono do arquivo. O script também gera um `ADMIN_TOKEN` para o relatório de consumo.
3. Para conferir depois: `npm run check-ai`.

Nunca cole a chave em chats, no código ou no APK: quem tiver a chave gasta os seus créditos.

Sem `ANTHROPIC_API_KEY` o jogo funciona normalmente com as 24 cartas clássicas do banco. Só os recursos de IA ficam desativados.

Variáveis de ambiente:

- `ANTHROPIC_API_KEY`: chave da Claude API (ativa os recursos de IA)
- `CLAUDE_MODEL`: modelo usado (padrão `claude-opus-5-5`)
- `PORT`: porta HTTP (padrão `3000`)
- `DB_PATH`: arquivo do banco SQLite (padrão `./data/perfil.db`)
- `AI_DAILY_BUDGET_USD`: orçamento diário de IA em US$ (padrão `5`)
- `AI_MAX_COST_PER_CALL_USD`: custo máximo de uma geração (padrão `0.5`)
- `AI_USER_DAILY_LIMIT`: pedidos à IA por jogador por dia (padrão `30`)
- `ADMIN_TOKEN`: libera o relatório `/api/admin/usage`
- `CORS_ORIGINS`: origens extras liberadas, separadas por vírgula

## Cartas da internet (Wikipédia)

`server/wiki.js` busca o artigo pela API pública da Wikipédia em português (`pt.wikipedia.org`). As dicas saem do texto do artigo: as frases mais específicas, com datas e nomes, viram as dicas difíceis, e o resumo do começo vira as fáceis. O nome da resposta, os apelidos e as palavras do nome são trocados por "esta pessoa", "deste lugar" ou "isto". Frases que perdem o sentido com essa troca são descartadas. A carta só é salva se passar no mesmo validador das cartas da IA.

- Assunto que já está no banco é reaproveitado, sem acessar a internet.
- Termos ambíguos (por exemplo "Mercúrio") pedem um nome mais específico.
- No fim da partida aparece o link do artigo, como pede a licença CC BY-SA da Wikipédia.
- `WEB_USER_DAILY_LIMIT` (padrão 30) limita as cartas criadas por jogador por dia. `WIKI_USER_AGENT` identifica o seu servidor para a Wikimedia, e você pode incluir um e-mail de contato.

O servidor precisa de acesso à internet para essa função. Os temas nativos funcionam sem internet.

## App Android (APK)

O app é feito com [Capacitor](https://capacitorjs.com): ele empacota a interface e conversa com o servidor, que guarda a chave da IA.

**Pelo GitHub (sem instalar nada):** a cada push, o workflow `Android APK` (`.github/workflows/android.yml`) roda os testes e compila o APK. Baixe o arquivo `perfil-ia-apk` na aba *Actions* do repositório. Para embutir o endereço do servidor, rode o workflow manualmente (*Run workflow*) preenchendo `server_url`, ou defina a variável `PERFIL_SERVER_URL` do repositório.

**Na sua máquina** (requer JDK 21 e Android SDK):

```bash
PERFIL_SERVER_URL=http://SEU_IP:3000 npm run android:build
# APK em android/app/build/outputs/apk/debug/app-debug.apk
```

No celular, instale o APK (permita "fontes desconhecidas"). Se o servidor não foi embutido, abra o app e informe o endereço no painel **Servidor** da tela inicial. O servidor precisa estar acessível pelo celular, seja na mesma rede Wi-Fi ou publicado na internet.

O APK gerado é de *debug* (assinado com chave de teste). Para publicar na Play Store, configure uma chave de assinatura e use `npm run android:release`.

## Testes

```bash
npm test
```

Cobrem a verificação de palpites (acentos, apelidos, erros de digitação), as regras da partida solo e das salas multiplayer (turnos, tempo, fim de rodada), a API REST, o débito e o reembolso de tokens e a validação das cartas da IA, que usa um cliente simulado e por isso não gasta créditos.

## Estrutura

```
server/
  index.js     servidor Express + Socket.IO (API REST e salas em tempo real)
  game.js      regras: pontuação, partida solo, salas multiplayer
  matching.js  verificação tolerante de palpites
  ai.js        Claude API: geração, consumo real e controle de custos
  cards.js     validação de cartas, categorias e duplicatas
  db.js        SQLite: cartas, categorias, jogadas, dicas, consumo, usuários
  seed.js      24 cartas clássicas
  themes.js    20 temas nativos (cartas prontas + assuntos extras para a internet)
  catalog.js   junta cartas clássicas e dos temas
  wiki.js      cria cartas a partir da Wikipédia, sem IA
public/        interface web (HTML/CSS/JS, sem build)
android/       projeto Android (Capacitor)
scripts/       build-web.mjs: monta www/ para o APK
test/          testes com node:test
```

## Observações

- A identificação dos jogadores é simples: um ID aleatório salvo no navegador, sem login. Para produção, adicione autenticação antes de vender ou distribuir tokens de verdade.
- As 24 cartas clássicas também têm 20 dicas e passam pelo mesmo validador das cartas da IA (`test/seed.test.js`). Bancos antigos são atualizados automaticamente ao iniciar o servidor, sem perder as estatísticas.
- As chamadas à IA usam o fallback do servidor da Anthropic (`fallbacks: "default"`). Se o modelo principal recusar um pedido, outro modelo tenta responder.
