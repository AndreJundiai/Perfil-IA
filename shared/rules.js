// Custos e recompensas do sistema de tokens do jogo (créditos do jogador, não tokens da API).
// Usado pelo servidor e pelo modo sem servidor do app.
export const TOKEN_RULES = {
  initial: 20,
  dailyBonus: 5,
  costGenerateCard: 2,
  costChallenge: 5,
  costAiHint: 1,
  rewardQuickGuess: 1, // acertar usando até 3 dicas
};
