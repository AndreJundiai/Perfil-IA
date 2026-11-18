---
name: perfil-ai
description: Gerencia a integração com inteligência artificial do Perfil IA e a geração de cartas, categorias e dicas. Use ao mexer em server/ai.js, server/cards.js, na validação de cartas, no reaproveitamento do banco ou no controle de custos da IA.
---

# Inteligência Artificial

Responsável pela integração da IA ao Perfil IA.

## Funções

1. Gerar cartas.
2. Gerar exatamente 20 dicas por carta (`CLUES_PER_CARD` em `server/cards.js`).
3. Criar categorias (tabela `categories`; a IA devolve rótulo e pergunta de categorias novas).
4. Validar dicas (`validateCard` em `server/cards.js`).
5. Evitar respostas duplicadas (coluna `answer_key` + apelidos normalizados).
6. Validar a qualidade do conteúdo (tamanho, repetição, vazamento da resposta).

## Regras

- Não revelar a resposta nas dicas: nenhuma dica pode conter a resposta ou um apelido.
- Não gerar cartas sem categoria.
- Validar o JSON antes de salvar (`validateCard`), e nunca salvar cartas inválidas.
- Reutilizar cartas existentes: antes de chamar a IA, procurar no banco uma carta compatível que o jogador ainda não jogou (`findReusableCards`), e reaproveitar dicas extras já geradas (`card_hints`).
- Nunca chamar a IA desnecessariamente.

## Segurança

- A chave da API fica só no backend (`ANTHROPIC_API_KEY` no `.env` do servidor).
- Nunca expor chaves no JavaScript do navegador nem no APK.
- Registrar o consumo real de tokens de cada chamada (`ai_usage`, a partir de `response.usage`).
- Controlar o custo por geração: `max_tokens` limitado, orçamento diário global (`AI_DAILY_BUDGET_USD`) e limite diário de chamadas por jogador (`AI_USER_DAILY_LIMIT`).

## Android

- O APK (Capacitor, pasta `android/`) só empacota a interface; ele conversa com o servidor, que guarda a chave.
- Gerar com `npm run android:build` (requer Android SDK) ou pelo workflow `.github/workflows/android.yml`.
