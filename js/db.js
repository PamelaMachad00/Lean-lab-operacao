/**
 * Camada de banco de dados: tenta o Firestore (Firebase) e cai para um
 * banco local guardado no navegador quando o Firebase não está configurado
 * ou está inacessível.
 *
 * As duas implementações expõem a MESMA interface (`.doc()`, `.collection()`
 * com `.get()/.set()/.update()/.delete()/.add()/.where()/.orderBy()/.limit()
 * /.onSnapshot()`), no formato do SDK do Firestore — então o resto do app
 * (js/app.js) não sabe nem precisa saber qual dos dois está em uso.
 */

import { firebaseConfig } from './firebase-config.js';

/**
 * Banco local de reserva (fallback), guardado em `localStorage`.
 * Sobrevive a atualizar a página (F5), mas é local a este navegador: não
 * sincroniza com outro celular ou computador. Existe pra o app continuar
 * testável antes de configurar o Firebase, ou se ele ficar fora do ar.
 */
export function criarDbLocal() {
  const CHAVE_LOCAL = 'leanlab_local_db_v1';
  const colecoes = new Map();
  const listeners = new Map();
  let contador = 1;

  function carregarDoLocalStorage() {
    try {
      const bruto = localStorage.getItem(CHAVE_LOCAL);
      if (!bruto) return;
      const salvo = JSON.parse(bruto);
      Object.keys(salvo.colecoes || {}).forEach((nome) => {
        colecoes.set(nome, new Map(Object.entries(salvo.colecoes[nome])));
      });
      if (typeof salvo.contador === 'number') contador = salvo.contador;
    } catch (e) {
      /* localStorage indisponível ou dado corrompido — começa vazio */
    }
  }
  function salvarNoLocalStorage() {
    try {
      const colecoesObj = {};
      colecoes.forEach((mapa, nome) => {
        colecoesObj[nome] = Object.fromEntries(mapa);
      });
      localStorage.setItem(CHAVE_LOCAL, JSON.stringify({ colecoes: colecoesObj, contador }));
    } catch (e) {
      /* modo privado, cota cheia etc. — segue só em memória */
    }
  }
  carregarDoLocalStorage();

  function mapaColecao(nome) {
    if (!colecoes.has(nome)) colecoes.set(nome, new Map());
    return colecoes.get(nome);
  }
  function snap(id, dados) {
    return {
      id,
      exists: dados !== undefined,
      data: () => (dados === undefined ? undefined : { ...dados }),
    };
  }
  function notificar(nome) {
    salvarNoLocalStorage();
    const set = listeners.get(nome);
    if (set) set.forEach((fn) => fn());
  }
  function doc(caminho) {
    const [colNome, id] = caminho.split('/');
    const col = mapaColecao(colNome);
    return {
      async get() {
        return snap(id, col.get(id));
      },
      async set(dados) {
        col.set(id, { ...dados });
        notificar(colNome);
      },
      async update(patch) {
        const atual = col.get(id) || {};
        col.set(id, { ...atual, ...patch });
        notificar(colNome);
      },
      async delete() {
        col.delete(id);
        notificar(colNome);
      },
    };
  }
  function collection(nome) {
    const col = mapaColecao(nome);
    let filtros = [];
    let ordCampo = null;
    let ordDir = 'asc';
    let limiteN = null;
    function consultar() {
      let arr = Array.from(col.entries()).map(([id, dados]) => ({ id, dados }));
      filtros.forEach((f) => {
        arr = arr.filter((d) => (f.op === '==' ? d.dados[f.campo] === f.val : true));
      });
      if (ordCampo) {
        arr.sort((a, b) => {
          const av = a.dados[ordCampo];
          const bv = b.dados[ordCampo];
          if (av < bv) return ordDir === 'desc' ? 1 : -1;
          if (av > bv) return ordDir === 'desc' ? -1 : 1;
          return 0;
        });
      }
      if (limiteN) arr = arr.slice(0, limiteN);
      return arr.map((d) => snap(d.id, d.dados));
    }
    const api = {
      where(campo, op, val) {
        filtros.push({ campo, op, val });
        return api;
      },
      orderBy(campo, dir) {
        ordCampo = campo;
        ordDir = dir || 'asc';
        return api;
      },
      limit(n) {
        limiteN = n;
        return api;
      },
      async add(dados) {
        const id = 'auto' + contador++;
        col.set(id, { ...dados });
        notificar(nome);
        return { id };
      },
      async get() {
        return { docs: consultar() };
      },
      onSnapshot(onNext, onErr) {
        const fn = () => {
          try {
            onNext({ docs: consultar() });
          } catch (e) {
            if (onErr) onErr(e);
          }
        };
        if (!listeners.has(nome)) listeners.set(nome, new Set());
        listeners.get(nome).add(fn);
        fn();
        return () => listeners.get(nome).delete(fn);
      },
    };
    return api;
  }
  return { doc, collection };
}

/**
 * Inicializa o banco de dados: tenta o Firestore com `firebaseConfig`; se a
 * configuração ainda estiver com os valores de exemplo, ou o SDK do
 * Firebase não tiver carregado, ou a inicialização falhar por qualquer
 * motivo, cai para `criarDbLocal()`.
 *
 * @returns {Promise<{db: object, real: boolean}>}
 */
export async function iniciarBancoDeDados() {
  try {
    const configPreenchida =
      firebaseConfig.apiKey && firebaseConfig.apiKey.indexOf('COLE_AQUI') === -1;
    if (configPreenchida && typeof firebase !== 'undefined') {
      firebase.initializeApp(firebaseConfig);
      return { db: firebase.firestore(), real: true };
    }
  } catch (e) {
    console.warn('Não deu pra iniciar o Firebase, caindo pro modo local:', e);
  }
  return { db: criarDbLocal(), real: false };
}
