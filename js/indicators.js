/**
 * Cálculo dos indicadores da linha a partir das leituras gravadas.
 *
 * Todas as funções aqui são puras: recebem o array de leituras (e, quando
 * preciso, o índice do posto) e devolvem um valor, sem tocar no DOM nem no
 * banco de dados. Isso é proposital — é o que torna essa camada testável
 * isoladamente (ver tests/indicators.test.js) e reutilizável em qualquer
 * lugar que precise "saber o que os dados dizem", desde o painel até o
 * relatório da rodada.
 *
 * @typedef {Object} Leitura
 * @property {number} posto      Índice do posto (0-based).
 * @property {number} cmin       Tempo de ciclo medido, em centésimos de minuto.
 * @property {'ok'|'nok'|'anomalia'} tipo
 * @property {string} usuario
 * @property {string} criadoEm   ISO 8601.
 */

import { POSTOS } from './config.js';

/** Média móvel das últimas 5 medições de um array de tempos (cmin). */
export function media(valores) {
  if (!valores.length) return 0;
  const ultimas = valores.slice(-5);
  return Math.round(ultimas.reduce((soma, v) => soma + v, 0) / ultimas.length);
}

/** Formata um número com 1 casa decimal e vírgula (padrão brasileiro). */
export function fmt1(numero) {
  return (Math.round(numero * 10) / 10).toFixed(1).replace('.', ',');
}

/** Leituras de um posto específico, em ordem cronológica crescente. */
export function leiturasDoPosto(leituras, indicePosto) {
  return leituras
    .filter((l) => l.posto === indicePosto)
    .sort((a, b) => (a.criadoEm < b.criadoEm ? -1 : 1));
}

/** Nome de quem fez a leitura mais recente num posto (ou o padrão, se nenhuma). */
export function ultimoOperadorPosto(leituras, indicePosto) {
  const doPosto = leiturasDoPosto(leituras, indicePosto);
  return doPosto.length
    ? doPosto[doPosto.length - 1].usuario || POSTOS[indicePosto].operador
    : POSTOS[indicePosto].operador;
}

/** Tempo de ciclo médio (cmin) das últimas leituras de um posto. */
export function mediaPosto(leituras, indicePosto) {
  const cmins = leiturasDoPosto(leituras, indicePosto).map((l) => l.cmin);
  return media(cmins);
}

/** Um posto está fora do padrão quando sua média passa 5% do objetivo da FOS. */
export function posEstaForaDoPadrao(leituras, indicePosto) {
  const m = mediaPosto(leituras, indicePosto);
  return m > 0 && m > POSTOS[indicePosto].objetivo * 1.05;
}

/**
 * Posto restritivo: aquele cuja razão (tempo medido / objetivo da FOS) é a
 * maior entre todos — é ele que limita o ritmo de toda a linha.
 */
export function indiceRestritivo(leituras) {
  let indice = 0;
  let piorRazao = -Infinity;
  POSTOS.forEach((posto, i) => {
    const m = mediaPosto(leituras, i) || posto.base;
    const razao = m / posto.objetivo;
    if (razao > piorRazao) {
      piorRazao = razao;
      indice = i;
    }
  });
  return indice;
}

/**
 * Estoque em processo (WIP) entre um posto e o seguinte: peças que já
 * saíram OK do posto `i` mas ainda não saíram OK do posto `i + 1`.
 */
export function wipDoPosto(leituras, indicePosto) {
  const okNoInicio = leituras.filter((l) => l.posto === indicePosto && l.tipo === 'ok').length;
  const okNoFim = leituras.filter((l) => l.posto === indicePosto + 1 && l.tipo === 'ok').length;
  return Math.max(0, okNoInicio - okNoFim);
}

/** Total de peças que saíram OK do último posto da linha. */
export function totalConcluidos(leituras) {
  return leituras.filter((l) => l.posto === POSTOS.length - 1 && l.tipo === 'ok').length;
}

/** Total de leituras marcadas como retrabalho. */
export function totalRetrabalho(leituras) {
  return leituras.filter((l) => l.tipo === 'nok').length;
}

/** Porcentagem das leituras cujo tempo medido ficou dentro do objetivo da FOS (+5%). */
export function aderenciaFOS(leituras) {
  const comCmin = leituras.filter((l) => typeof l.cmin === 'number');
  if (!comCmin.length) return 0;
  const dentro = comCmin.filter((l) => l.cmin <= POSTOS[l.posto].objetivo * 1.05).length;
  return Math.round((100 * dentro) / comCmin.length);
}

/**
 * Lead time médio estimado: soma dos tempos médios de cada posto (convertida
 * de cmin para minutos) mais uma penalidade proporcional ao maior estoque em
 * processo entre os postos — quanto mais peças acumuladas, mais tempo uma
 * peça nova leva para atravessar a linha inteira.
 */
export function leadTimeMedioEstimado(leituras) {
  const somaMedias = POSTOS.reduce((soma, p, i) => soma + (mediaPosto(leituras, i) || p.base), 0);
  const wipMaximo = Math.max(0, ...POSTOS.slice(0, -1).map((_, i) => wipDoPosto(leituras, i)));
  return (somaMedias / 100) * 2.3 + wipMaximo * 0.45;
}
