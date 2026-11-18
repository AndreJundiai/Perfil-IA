# Perfil IA

**Descubra quem, o que ou qual lugar está escondido por trás das dicas!**

O jogador recebe uma carta misteriosa com 10 dicas, da mais difícil para a mais fácil, e precisa adivinhar a resposta usando o menor número possível de dicas. A inteligência artificial (Claude, da Anthropic) cria cartas, gera dicas extras e monta desafios personalizados.

## Funcionalidades

| Funcionalidade | Como funciona |
| --- | --- |
| **Partida individual** | Você joga contra a IA: abre dicas e chuta quando quiser. Acertar com 1 dica vale 10 pontos, com 10 dicas vale 1. Cada palpite errado abre mais uma dica. |
| **Multiplayer online** | Crie uma sala, compartilhe o código de 4 letras e jogue com até 8 amigos em tempo real. Na sua vez, você chuta ou pede mais uma dica; quem acertar primeiro leva os pontos da carta. |
| **Cartas inteligentes** | A IA cria uma carta nova (categoria, tema e dificuldade à sua escolha). |
| **Desafio personalizado** | Você escolhe um tema ("Copa do Mundo", "mitologia grega"…) e a IA monta uma sequência de 5 cartas. |
| **Dica da IA** | Travou? A IA escreve uma dica extra sob medida (custa 1 ponto no acerto). |
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

Se a IA falhar, os tokens são devolvidos automaticamente. Os valores ficam em `TOKEN_RULES` (`server/db.js`).

## Como rodar

Requer **Node.js 22.13+** (o banco usa o módulo nativo `node:sqlite`).

```bash
npm install
cp .env.example .env    # opcional: coloque sua ANTHROPIC_API_KEY
npm start               # http://localhost:3000
```

Sem `ANTHROPIC_API_KEY` o jogo funciona normalmente com as 24 cartas clássicas do banco. Só os recursos de IA ficam desativados.

Variáveis de ambiente:

- `ANTHROPIC_API_KEY`: chave da Claude API (ativa os recursos de IA)
- `CLAUDE_MODEL`: modelo usado (padrão `claude-opus-5-5`)
- `PORT`: porta HTTP (padrão `3000`)
- `DB_PATH`: arquivo do banco SQLite (padrão `./data/perfil.db`)

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
  ai.js        Claude API: cartas, dicas e desafios (saída JSON estruturada)
  db.js        SQLite: cartas, usuários, tokens
  seed.js      cartas clássicas iniciais
public/        interface web (HTML/CSS/JS, sem build)
test/          testes com node:test
```

## Observações

- A identificação dos jogadores é simples: um ID aleatório salvo no navegador, sem login. Para produção, adicione autenticação antes de vender ou distribuir tokens de verdade.
- As cartas da IA passam por uma validação: dicas que entregam a resposta antes da última são descartadas, e respostas que já existem no banco são ignoradas.
- As chamadas à IA usam o fallback do servidor da Anthropic (`fallbacks: "default"`). Se o modelo principal recusar um pedido, outro modelo tenta responder.
