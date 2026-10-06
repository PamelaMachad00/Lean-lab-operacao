import { describe, it, expect } from 'vitest';
import {
  media,
  fmt1,
  leiturasDoPosto,
  ultimoOperadorPosto,
  mediaPosto,
  posEstaForaDoPadrao,
  indiceRestritivo,
  wipDoPosto,
  totalConcluidos,
  totalRetrabalho,
  aderenciaFOS,
  leadTimeMedioEstimado,
} from '../js/indicators.js';
import { POSTOS } from '../js/config.js';

/** Fábrica de leitura, pra não repetir os mesmos campos em todo teste. */
function leitura(overrides) {
  return {
    posto: 0,
    cmin: POSTOS[0].objetivo,
    tipo: 'ok',
    usuario: 'Teste',
    criadoEm: new Date().toISOString(),
    ...overrides,
  };
}

describe('media', () => {
  it('devolve 0 pra um array vazio', () => {
    expect(media([])).toBe(0);
  });

  it('usa só as últimas 5 medições', () => {
    // as 3 primeiras (10,10,10) ficam de fora da janela de 5
    expect(media([10, 10, 10, 20, 20, 20, 20, 20])).toBe(20);
  });

  it('arredonda o resultado', () => {
    expect(media([1, 2])).toBe(Math.round(1.5));
  });
});

describe('fmt1', () => {
  it('formata com 1 casa decimal e vírgula', () => {
    expect(fmt1(21.44)).toBe('21,4');
    expect(fmt1(21.46)).toBe('21,5');
    expect(fmt1(10)).toBe('10,0');
  });
});

describe('leiturasDoPosto', () => {
  it('filtra só as leituras do posto pedido, em ordem cronológica', () => {
    const leituras = [
      leitura({ posto: 0, criadoEm: '2026-01-01T10:00:00.000Z' }),
      leitura({ posto: 1, criadoEm: '2026-01-01T10:05:00.000Z' }),
      leitura({ posto: 0, criadoEm: '2026-01-01T09:00:00.000Z' }),
    ];
    const doPosto0 = leiturasDoPosto(leituras, 0);
    expect(doPosto0).toHaveLength(2);
    expect(doPosto0[0].criadoEm).toBe('2026-01-01T09:00:00.000Z');
    expect(doPosto0[1].criadoEm).toBe('2026-01-01T10:00:00.000Z');
  });
});

describe('ultimoOperadorPosto', () => {
  it('devolve o operador padrão do posto quando não há leituras', () => {
    expect(ultimoOperadorPosto([], 0)).toBe(POSTOS[0].operador);
  });

  it('devolve o usuário da leitura mais recente do posto', () => {
    const leituras = [
      leitura({ posto: 0, usuario: 'Bruna', criadoEm: '2026-01-01T09:00:00.000Z' }),
      leitura({ posto: 0, usuario: 'Kauê', criadoEm: '2026-01-01T10:00:00.000Z' }),
    ];
    expect(ultimoOperadorPosto(leituras, 0)).toBe('Kauê');
  });
});

describe('mediaPosto / posEstaForaDoPadrao', () => {
  it('marca fora do padrão quando a média passa 5% do objetivo', () => {
    const objetivo = POSTOS[0].objetivo;
    const leituras = [leitura({ posto: 0, cmin: Math.round(objetivo * 1.2) })];
    expect(mediaPosto(leituras, 0)).toBe(Math.round(objetivo * 1.2));
    expect(posEstaForaDoPadrao(leituras, 0)).toBe(true);
  });

  it('não marca fora do padrão sem leituras (média 0)', () => {
    expect(posEstaForaDoPadrao([], 0)).toBe(false);
  });

  it('não marca fora do padrão dentro da margem de 5%', () => {
    const objetivo = POSTOS[0].objetivo;
    const leituras = [leitura({ posto: 0, cmin: objetivo })];
    expect(posEstaForaDoPadrao(leituras, 0)).toBe(false);
  });
});

describe('indiceRestritivo', () => {
  it('aponta o posto com a pior razão medido/objetivo', () => {
    const leituras = POSTOS.map((p, i) => leitura({ posto: i, cmin: p.objetivo }));
    // Deixa o posto 2 bem acima do objetivo — ele deve virar o restritivo
    leituras[2] = leitura({ posto: 2, cmin: Math.round(POSTOS[2].objetivo * 2) });
    expect(indiceRestritivo(leituras)).toBe(2);
  });

  it('sem nenhuma leitura, cai pro posto com pior razão base/objetivo', () => {
    const idx = indiceRestritivo([]);
    const esperado = POSTOS.reduce(
      (piorIdx, p, i, arr) => (p.base / p.objetivo > arr[piorIdx].base / arr[piorIdx].objetivo ? i : piorIdx),
      0
    );
    expect(idx).toBe(esperado);
  });
});

describe('wipDoPosto', () => {
  it('conta peças OK que saíram de um posto mas não entraram OK no próximo', () => {
    const leituras = [
      leitura({ posto: 0, tipo: 'ok' }),
      leitura({ posto: 0, tipo: 'ok' }),
      leitura({ posto: 1, tipo: 'ok' }),
    ];
    expect(wipDoPosto(leituras, 0)).toBe(1);
  });

  it('nunca devolve um número negativo', () => {
    const leituras = [leitura({ posto: 1, tipo: 'ok' })];
    expect(wipDoPosto(leituras, 0)).toBe(0);
  });
});

describe('totalConcluidos / totalRetrabalho', () => {
  it('conta só OKs do último posto como concluídos', () => {
    const ultimo = POSTOS.length - 1;
    const leituras = [
      leitura({ posto: ultimo, tipo: 'ok' }),
      leitura({ posto: ultimo, tipo: 'nok' }),
      leitura({ posto: 0, tipo: 'ok' }),
    ];
    expect(totalConcluidos(leituras)).toBe(1);
  });

  it('conta leituras nok como retrabalho, em qualquer posto', () => {
    const leituras = [leitura({ tipo: 'nok' }), leitura({ tipo: 'nok' }), leitura({ tipo: 'ok' })];
    expect(totalRetrabalho(leituras)).toBe(2);
  });
});

describe('aderenciaFOS', () => {
  it('devolve 0 sem leituras com cmin', () => {
    expect(aderenciaFOS([])).toBe(0);
  });

  it('calcula a porcentagem dentro do objetivo (+5%)', () => {
    const objetivo = POSTOS[0].objetivo;
    const leituras = [
      leitura({ posto: 0, cmin: objetivo }), // dentro
      leitura({ posto: 0, cmin: Math.round(objetivo * 2) }), // fora
    ];
    expect(aderenciaFOS(leituras)).toBe(50);
  });
});

describe('leadTimeMedioEstimado', () => {
  it('sem leituras, usa o tempo base de cada posto (nunca é negativo ou NaN)', () => {
    const lt = leadTimeMedioEstimado([]);
    expect(lt).toBeGreaterThan(0);
    expect(Number.isNaN(lt)).toBe(false);
  });

  it('aumenta quando o estoque em processo (WIP) aumenta', () => {
    const semWip = [];
    const comWip = [leitura({ posto: 0, tipo: 'ok' }), leitura({ posto: 0, tipo: 'ok' })];
    expect(leadTimeMedioEstimado(comWip)).toBeGreaterThan(leadTimeMedioEstimado(semWip));
  });
});
