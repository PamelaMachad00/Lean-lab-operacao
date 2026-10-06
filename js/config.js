/**
 * Dados de referência da linha de montagem.
 *
 * Estes valores foram levantados numa visita técnica ao laboratório de
 * Manufatura Enxuta do UniSenai: os cinco postos de trabalho, o tempo
 * objetivo de cada um (definido na Folha de Operação Standard — FOS) e o
 * takt time da linha. `base` é o tempo de ciclo típico usado para simular
 * uma leitura de etiqueta (ver `gerarCmin` em app.js); numa integração com
 * sensores reais, `base` deixaria de existir e o tempo viria do sensor.
 *
 * @typedef {Object} Posto
 * @property {string} nome
 * @property {number} objetivo  Tempo-alvo em cmin (centésimos de minuto), da FOS.
 * @property {number} base      Tempo de ciclo típico, usado para simular leituras.
 * @property {string} operador  Operador de referência exibido antes da primeira leitura.
 */

/** Ritmo (em cmin) que a linha precisa manter para atender a demanda. */
export const TAKT = 110;

/** @type {Posto[]} */
export const POSTOS = [
  { nome: 'Posto 1', objetivo: 95, base: 93, operador: 'Bruna' },
  { nome: 'Posto 2', objetivo: 104, base: 116, operador: 'Diego' },
  { nome: 'Posto 3', objetivo: 98, base: 100, operador: 'Ana' },
  { nome: 'Posto 4', objetivo: 111, base: 109, operador: 'Kauê' },
  { nome: 'Posto 5', objetivo: 86, base: 89, operador: 'Iara' },
];

/** Peça/etiqueta associada a cada posto, exibida na tela de leitura. */
export const PARTES = [
  { ref: 'D081345021 / A', nome: 'Chassi Base · Setor A' },
  { ref: 'D076541133 / B', nome: 'Suporte Motor · Setor B' },
  { ref: 'D064210987 / C', nome: 'Conector Elétrico · Setor C' },
  { ref: 'D059871234 / A', nome: 'Tampa Final · Setor A' },
  { ref: 'SOLETROM / FINAL', nome: 'Soletrom · Montagem final' },
];

/**
 * Indicadores da Rodada 1 da turma MEC-241, usados como referência de
 * comparação no painel ("rodada 1 · X") enquanto a rodada atual acontece.
 */
export const BASELINE = {
  aderencia: 78,
  leadTime: 21.4,
  wipMax: 9,
  concluidos: 11,
  retrabalho: 6,
  anomalias: 5,
};
