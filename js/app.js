/**
 * Controlador da aplicação: estado, autenticação, câmera/QR Code,
 * renderização de telas e navegação.
 *
 * Os módulos vizinhos (config.js, db.js, indicators.js) cuidam de dados de
 * referência, persistência e cálculo dos indicadores — este arquivo é a
 * "cola" entre eles e o DOM. Ele concentra tudo que manipula a página
 * diretamente (estado da UI, formulários, câmera, renderização), porque
 * essa parte é fortemente acoplada ao HTML e fatiar em módulos menores só
 * ia espalhar esse acoplamento sem tornar nada mais testável — o que vale a
 * pena isolar (os cálculos) já está isolado em indicators.js.
 */

import { TAKT, POSTOS, PARTES, BASELINE } from './config.js';
import { iniciarBancoDeDados } from './db.js';
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
} from './indicators.js';

/**
 * Estado da aplicação inteiro num único objeto — em vez de várias variáveis
 * soltas no escopo do módulo. Facilita ver, num só lugar, tudo que muda
 * enquanto o app roda, e evita poluir o escopo do módulo com `let`s.
 */
const state = {
  db: null,
  currentUser: null, // {login, nome, posto}
  leituras: [], // cache da coleção 'leituras' (desc por criadoEm)
  anomaliasAbertas: [],
  unsubLeituras: null,
  unsubAnomalias: null,
  scanner: null,
  scannerAtivo: false,
  pendingLeitura: null, // {posto, cmin, parte}
  modalCtx: null,
  entradaScanner: null,
  entradaScannerAtivo: false,
  postoReconhecido: null,
  modoOperador: false,
  tourEtapa: 1,
};

/* =========================================================
   HELPERS DE UI
   ========================================================= */
function horaDe(iso) {
  const d = new Date(iso);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((v) => String(v).padStart(2, '0')).join(':');
}
function toast(msg, tipo) {
  const el = document.getElementById('toast');
  document.getElementById('toastTxt').textContent = msg;
  el.className = 'toast show' + (tipo ? ' ' + tipo : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2800);
}
/** Simula a leitura de um sensor de tempo de ciclo (cmin) pra este protótipo. */
function gerarCmin(postoIdx) {
  const p = POSTOS[postoIdx];
  const ruido = (Math.random() - 0.5) * 16;
  return Math.max(10, Math.round(p.base + ruido));
}

/* =========================================================
   TOOLTIPS DE TERMO
   ========================================================= */
function fecharTodasTips(exceto) {
  document.querySelectorAll('.tip-pop').forEach((p) => {
    if (p.id !== exceto) p.hidden = true;
  });
  document.querySelectorAll('.tip-btn').forEach((b) => {
    if (b.getAttribute('aria-controls') !== exceto) b.setAttribute('aria-expanded', 'false');
  });
}
function toggleTip(btn) {
  const id = btn.getAttribute('aria-controls');
  const pop = document.getElementById(id);
  const abrindo = pop.hidden;
  fecharTodasTips(abrindo ? id : null);
  pop.hidden = !abrindo;
  btn.setAttribute('aria-expanded', String(abrindo));
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.tip-wrap')) fecharTodasTips(null);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') fecharTodasTips(null);
});

/* =========================================================
   AJUDA (drawer) + TOUR DE BOAS-VINDAS
   ========================================================= */
function abrirAjuda() {
  document.getElementById('ajudaBackdrop').classList.add('show');
  document.getElementById('ajudaFechar').focus();
}
function fecharAjuda() {
  document.getElementById('ajudaBackdrop').classList.remove('show');
}
document.getElementById('btnAjuda').addEventListener('click', abrirAjuda);
document.getElementById('ajudaFechar').addEventListener('click', fecharAjuda);
document.getElementById('ajudaBackdrop').addEventListener('click', (e) => {
  if (e.target.id === 'ajudaBackdrop') fecharAjuda();
});

function renderTour() {
  document.querySelectorAll('.tour-passo').forEach((p) => p.classList.toggle('ativo', Number(p.dataset.passo) === state.tourEtapa));
  document.querySelectorAll('.tour-pontos span').forEach((s, i) => s.classList.toggle('ativo', i === state.tourEtapa - 1));
  document.getElementById('tourProx').textContent = state.tourEtapa === 3 ? 'Começar' : 'Próximo';
}
function fecharTour() {
  document.getElementById('tourBackdrop').classList.remove('show');
  try {
    localStorage.setItem('leanlab_tour_visto', '1');
  } catch (e) {
    /* localStorage indisponível — só não lembra da próxima vez */
  }
}
document.getElementById('tourPular').addEventListener('click', fecharTour);
document.getElementById('tourProx').addEventListener('click', () => {
  if (state.tourEtapa < 3) {
    state.tourEtapa++;
    renderTour();
  } else {
    fecharTour();
  }
});
function mostrarTourSeNecessario() {
  let visto = false;
  try {
    visto = localStorage.getItem('leanlab_tour_visto') === '1';
  } catch (e) {
    /* localStorage indisponível — mostra o tour normalmente */
  }
  if (visto) return;
  state.tourEtapa = 1;
  renderTour();
  document.getElementById('tourBackdrop').classList.add('show');
}

/* =========================================================
   ENTRADA — coordenador (nome + senha) OU operador (QR do posto)
   ========================================================= */
function normalizarLogin(nome) {
  return (nome || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
function bufParaHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
async function sha256Hex(texto) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return bufParaHex(buf);
}
function saltAleatorio() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
async function hashSenha(senha, salt) {
  return sha256Hex(salt + ':::' + senha);
}

function loginErro(msg) {
  const el = document.getElementById('loginErro');
  if (!msg) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.textContent = msg;
  el.hidden = false;
}

/* ---- coordenador: nome + senha, vê tudo ---- */
document.getElementById('formLogin').addEventListener('submit', async (e) => {
  e.preventDefault();
  loginErro(null);
  const nome = document.getElementById('loginNome').value.trim();
  const senha = document.getElementById('loginSenha').value;
  if (!nome || !senha) {
    loginErro('Preencha nome e senha.');
    return;
  }
  if (senha.length < 4) {
    loginErro('A senha precisa ter pelo menos 4 caracteres.');
    return;
  }
  const login = normalizarLogin(nome);
  if (!login) {
    loginErro('Digite um nome válido.');
    return;
  }
  if (!state.db) {
    loginErro('Ainda conectando ao banco de dados — aguarde um instante e tente de novo.');
    return;
  }

  const btn = document.getElementById('btnEntrar');
  btn.disabled = true;
  btn.textContent = 'Entrando…';
  try {
    const doc = await state.db.doc('usuarios/' + login).get();
    if (doc.exists) {
      const dados = doc.data();
      const hash = await hashSenha(senha, dados.salt);
      if (hash !== dados.senhaHash) {
        loginErro('Senha incorreta para esse nome.');
        btn.disabled = false;
        btn.textContent = 'Entrar';
        return;
      }
      entrarComoCoordenador({ login, nome: dados.nome });
    } else {
      const salt = saltAleatorio();
      const senhaHash = await hashSenha(senha, salt);
      await state.db.doc('usuarios/' + login).set({ nome, salt, senhaHash, criadoEm: new Date().toISOString() });
      toast('Conta de coordenador(a) criada', 'ok');
      entrarComoCoordenador({ login, nome });
    }
  } catch (err) {
    loginErro('Não deu pra entrar agora (' + ((err && err.code) || 'erro') + '). Tente de novo.');
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
});

function entrarComoCoordenador(usuario) {
  state.currentUser = { login: usuario.login, nome: usuario.nome, posto: null };
  state.modoOperador = false;
  const form = document.getElementById('formLogin');
  form.reset();
  loginErro(null);
  document.getElementById('btnEntrar').disabled = false;
  document.getElementById('btnEntrar').textContent = 'Entrar';
  document.getElementById('telaLogin').hidden = true;
  document.getElementById('app').hidden = false;
  document.getElementById('usrNome').textContent = usuario.nome;
  document.getElementById('usrPosto').textContent = 'Coordenador(a)';
  document.getElementById('usrAv').textContent = usuario.nome.trim().charAt(0).toUpperCase() || '?';
  ['tabBtn0', 'tabBtn2', 'tabBtn3'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = false;
  });
  iniciarAssinaturasDb();
  renderQrGrid();
  renderPessoasCadastro();
  renderLeituraCabecalho();
  renderPassos();
  ir(0, document.getElementById('tabBtn0'));
  mostrarTourSeNecessario();
}

/* ---- operador: escaneia o QR do posto, digita só o nome ---- */
document.getElementById('btnLigarCamEntrada').addEventListener('click', ligarCameraEntrada);
document.getElementById('btnEntradaManual').addEventListener('click', () => {
  const val = document.getElementById('entradaManual').value.trim();
  if (!val) return;
  onPostoDetectadoEntrada(val);
  document.getElementById('entradaManual').value = '';
});
document.getElementById('btnConfirmarNomeOperador').addEventListener('click', () => {
  const nome = document.getElementById('nomeOperadorInput').value.trim();
  if (!nome || state.postoReconhecido === null) return;
  entrarComoOperador(state.postoReconhecido, nome);
});
document.getElementById('nomeOperadorInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('btnConfirmarNomeOperador').click();
  }
});

async function ligarCameraEntrada() {
  const video = document.getElementById('entradaVideo');
  try {
    if (typeof QrScanner === 'undefined') throw new Error('lib ausente');
    QrScanner.WORKER_PATH = 'https://cdnjs.cloudflare.com/ajax/libs/qr-scanner/1.4.2/qr-scanner-worker.min.js';
    if (!state.entradaScanner) {
      state.entradaScanner = new QrScanner(video, (resultado) => onPostoDetectadoEntrada(resultado.data || resultado), {
        returnDetailedScanResult: true,
        highlightScanRegion: false,
        highlightCodeOutline: false,
      });
    }
    await state.entradaScanner.start();
    state.entradaScannerAtivo = true;
    video.hidden = false;
    document.getElementById('entradaQuadroParado').hidden = true;
    document.getElementById('entradaQuadroScan').hidden = false;
    document.getElementById('entradaVisorStatus').hidden = false;
  } catch (err) {
    toast('Não consegui acessar a câmera. Use o campo manual abaixo.', 'nok');
  }
}
function pararScannerEntrada() {
  if (state.entradaScanner && state.entradaScannerAtivo) {
    try {
      state.entradaScanner.stop();
    } catch (e) {
      /* scanner já parado ou não suportado — segue */
    }
  }
  state.entradaScannerAtivo = false;
  const video = document.getElementById('entradaVideo');
  if (video) video.hidden = true;
  const qp = document.getElementById('entradaQuadroParado');
  if (qp) qp.hidden = false;
  const qs = document.getElementById('entradaQuadroScan');
  if (qs) qs.hidden = true;
  const vs = document.getElementById('entradaVisorStatus');
  if (vs) vs.hidden = true;
}
/**
 * Aceita tanto o código puro digitado à mão (LEANLAB-POSTO-2) quanto uma URL
 * completa (a que fica dentro do QR Code agora, ex.: .../?posto=2), pra
 * funcionar tanto lendo pelo scanner do app quanto abrindo o link direto
 * (ex.: câmera nativa do celular apontada pra etiqueta impressa).
 */
function extrairPostoDeTexto(texto) {
  texto = (texto || '').trim();
  if (!texto) return null;
  let m = /^LEANLAB-POSTO-([1-5])$/.exec(texto);
  if (m) return Number(m[1]) - 1;
  try {
    const u = new URL(texto, location.href);
    const p = u.searchParams.get('posto');
    if (p && /^[1-5]$/.test(p)) return Number(p) - 1;
  } catch (e) {
    /* não era uma URL válida, segue pra próxima tentativa */
  }
  m = /LEANLAB-POSTO-([1-5])/.exec(texto);
  return m ? Number(m[1]) - 1 : null;
}

function onPostoDetectadoEntrada(texto) {
  const postoIdx = extrairPostoDeTexto(texto);
  if (postoIdx === null) {
    toast('Essa etiqueta não é de um posto do Lean Lab', 'nok');
    return;
  }
  if (state.entradaScannerAtivo) {
    try {
      state.entradaScanner.stop();
    } catch (e) {
      /* scanner já parado — segue */
    }
    state.entradaScannerAtivo = false;
  }
  state.postoReconhecido = postoIdx;
  document.getElementById('nomeOperadorPosto').textContent = POSTOS[postoIdx].nome;
  document.getElementById('nomeOperadorWrap').hidden = false;
  preencherSugestoesNomes(postoIdx);
  document.getElementById('nomeOperadorInput').focus();
}
async function preencherSugestoesNomes(postoIdx) {
  const dl = document.getElementById('listaPessoasPosto');
  if (!dl || !state.db) return;
  try {
    const snap = await state.db.collection('pessoas').get();
    const nomes = snap.docs
      .map((d) => d.data())
      .filter((p) => p.posto === postoIdx)
      .map((p) => p.nome);
    dl.innerHTML = nomes.map((n) => `<option value="${n}"></option>`).join('');
  } catch (e) {
    /* sugestões são um bônus — se falhar, o campo continua utilizável */
  }
}

/**
 * Se a página abrir já com ?posto=N (é isso que o QR Code das etiquetas
 * agora carrega), reconhece o posto na hora e já mostra "qual é o seu
 * nome?" — funciona mesmo escaneando com a câmera comum do celular, sem
 * precisar abrir a câmera de dentro do app.
 */
(function autoReconhecerPostoPelaUrl() {
  try {
    const postoIdx = extrairPostoDeTexto(location.href);
    if (postoIdx === null) return;
    const detalhes = document.getElementById('entradaOperador');
    if (detalhes) detalhes.open = true;
    onPostoDetectadoEntrada('LEANLAB-POSTO-' + (postoIdx + 1));
  } catch (e) {
    /* URL inesperada — sem problema, segue pro login normal */
  }
})();

function entrarComoOperador(postoIdx, nome) {
  pararScannerEntrada();
  state.currentUser = { login: null, nome, posto: postoIdx };
  state.modoOperador = true;
  document.getElementById('nomeOperadorWrap').hidden = true;
  document.getElementById('nomeOperadorInput').value = '';
  state.postoReconhecido = null;
  document.getElementById('telaLogin').hidden = true;
  document.getElementById('app').hidden = false;
  document.getElementById('usrNome').textContent = nome;
  document.getElementById('usrPosto').textContent = POSTOS[postoIdx].nome;
  document.getElementById('usrAv').textContent = nome.trim().charAt(0).toUpperCase() || '?';
  ['tabBtn0', 'tabBtn2', 'tabBtn3'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
  iniciarAssinaturasDb();
  renderLeituraCabecalho();
  renderPassos();
  renderInfoPostoOperador();
  ir(1, document.getElementById('tabBtn1'));
}

document.getElementById('btnSair').addEventListener('click', () => {
  pararScanner();
  pararScannerEntrada();
  if (state.unsubLeituras) state.unsubLeituras();
  if (state.unsubAnomalias) state.unsubAnomalias();
  state.currentUser = null;
  state.leituras = [];
  state.anomaliasAbertas = [];
  state.pendingLeitura = null;
  if (state.modoOperador) {
    ['tabBtn0', 'tabBtn2', 'tabBtn3'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = false;
    });
    state.modoOperador = false;
  }
  document.getElementById('app').hidden = true;
  document.getElementById('telaLogin').hidden = false;
});

/* =========================================================
   BANCO DE DADOS — assinaturas em tempo real
   ========================================================= */
function iniciarAssinaturasDb() {
  if (!state.db) return;
  state.unsubLeituras = state.db
    .collection('leituras')
    .orderBy('criadoEm', 'desc')
    .limit(300)
    .onSnapshot(
      (snap) => {
        state.leituras = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
        renderTudo();
      },
      (err) => toast('Não consegui ler o histórico agora (' + err.code + ')', 'nok')
    );
  state.unsubAnomalias = state.db
    .collection('anomalias')
    .where('resolvidoEm', '==', null)
    .onSnapshot(
      (snap) => {
        state.anomaliasAbertas = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
        renderAnomalias();
      },
      (err) => toast('Não consegui ler as anomalias agora (' + err.code + ')', 'nok')
    );
}

/* =========================================================
   GRÁFICOS EM SVG (usados no painel e no relatório)
   ========================================================= */
function sparklineSVG(values, objetivo) {
  const vals = values.slice(-6);
  if (vals.length < 2) return '<div class="spark-lbl">leituras insuficientes ainda</div>';
  const min = Math.min(...vals, objetivo) - 4;
  const max = Math.max(...vals, objetivo) + 4;
  const w = 120;
  const h = 26;
  const pad = 3;
  const pts = vals.map((v, i) => {
    const x = pad + (i / (vals.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2);
    return x.toFixed(1) + ',' + y.toFixed(1);
  });
  const yObj = h - pad - ((objetivo - min) / (max - min || 1)) * (h - pad * 2);
  const cor = vals[vals.length - 1] > objetivo * 1.05 ? '#D62839' : '#1E874B';
  const last = pts[pts.length - 1].split(',');
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <line x1="0" y1="${yObj.toFixed(1)}" x2="${w}" y2="${yObj.toFixed(1)}" stroke="#C4D0DC" stroke-width="1" stroke-dasharray="2,2"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="${cor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="2.6" fill="${cor}"/>
  </svg>`;
}
function trendSVG(values, corBase) {
  const vals = values.slice(-40);
  if (vals.length < 2) return '';
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const w = 300;
  const h = 64;
  const pad = 4;
  const pts = vals.map((v, i) => {
    const x = pad + (i / (vals.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2);
    return x.toFixed(1) + ',' + y.toFixed(1);
  });
  const area = pad + ',' + h + ' ' + pts.join(' ') + ' ' + (w - pad) + ',' + h;
  const last = pts[pts.length - 1].split(',');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polygon points="${area}" fill="${corBase}" opacity="0.10"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="${corBase}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="3.2" fill="${corBase}"/>
  </svg>`;
}

/* =========================================================
   RENDER — PAINEL
   ========================================================= */
function renderTrilho() {
  const restritivo = indiceRestritivo(state.leituras);
  let html = '';
  POSTOS.forEach((p, i) => {
    const cmins = leiturasDoPosto(state.leituras, i).map((l) => l.cmin);
    const m = mediaPosto(state.leituras, i) || p.base;
    const temDados = cmins.length > 0;
    const fora = posEstaForaDoPadrao(state.leituras, i);
    const desvio = !temDados
      ? 'sem leituras ainda'
      : m === p.objetivo
      ? 'no padrão'
      : m > p.objetivo
      ? `${m - p.objetivo} acima do padrão`
      : `${p.objetivo - m} abaixo do padrão`;
    html += `<div class="posto ${fora ? 'fora' : ''} ${i === restritivo ? 'restritivo' : ''}" role="button" tabindex="0" aria-label="Ir escanear uma etiqueta do ${p.nome}" data-action="ir-leitura" data-posto="${i}">
      <div class="p-cab"><span class="dot"></span><span>${p.nome}</span><span class="op">${ultimoOperadorPosto(state.leituras, i)}</span></div>
      <div class="medida"><span class="v num">${temDados ? m : '—'}</span><span class="u">cmin</span></div>
      <div class="alvo">objetivo ${p.objetivo}</div>
      <div class="desvio">${desvio}</div>
      ${sparklineSVG(cmins, p.objetivo)}
      ${cmins.length >= 2 ? `<div class="spark-lbl">últimas ${Math.min(6, cmins.length)} leituras</div>` : ''}
      <div class="ir-escanear">Escanear etiqueta →</div>
    </div>`;
  });
  document.getElementById('trilho').innerHTML = html;
}
function irParaLeitura(i) {
  const btn = document.getElementById('tabBtn1');
  ir(1, btn);
  toast(`Aponte a câmera pra etiqueta do ${POSTOS[i].nome}`, 'ok');
}
function tipHtml(id, texto) {
  return `<span class="tip-wrap"><button type="button" class="tip-btn" aria-expanded="false" aria-controls="${id}" data-action="toggle-tip">i</button><span class="tip-pop" id="${id}" role="tooltip" hidden>${texto}</span></span>`;
}
function renderInds() {
  const restritivo = POSTOS[indiceRestritivo(state.leituras)];
  const wipMax = Math.max(0, ...POSTOS.slice(0, -1).map((_, i) => wipDoPosto(state.leituras, i)));
  const html = `
    <div class="ind"><div class="r">Soletrons concluídos</div><div class="v num">${totalConcluidos(state.leituras)}</div><div class="n">rodada 1 · ${BASELINE.concluidos}</div></div>
    <div class="ind"><div class="r">Lead time médio${tipHtml('tipLeadInd', 'Tempo total que uma peça leva pra passar por todos os postos da linha.')}</div><div class="v num">${state.leituras.length ? fmt1(leadTimeMedioEstimado(state.leituras)) + ' min' : '—'}</div><div class="n">rodada 1 · ${fmt1(BASELINE.leadTime)} min</div></div>
    <div class="ind crit"><div class="r">Posto restritivo${tipHtml('tipRestrInd', 'O posto mais lento em relação ao seu objetivo — ele que limita o ritmo da linha.')}</div><div class="v">${restritivo.nome}</div><div class="n">${wipMax} peça${wipMax === 1 ? '' : 's'} acumulada${wipMax === 1 ? '' : 's'}</div></div>
    <div class="ind"><div class="r">Aderência à FOS${tipHtml('tipAderInd', 'Porcentagem das leituras dentro do tempo esperado pela Folha de Operação Standard.')}</div><div class="v num">${aderenciaFOS(state.leituras)}%</div><div class="n">rodada 1 · ${BASELINE.aderencia}%</div></div>
    <div class="ind"><div class="r">Retrabalho${tipHtml('tipRetrInd', 'Peças que não passaram no padrão e precisaram ser corrigidas antes de seguir.')}</div><div class="v num">${totalRetrabalho(state.leituras)}</div><div class="n">acumulado no banco</div></div>
  `;
  document.getElementById('inds').innerHTML = html;
}
function renderHistorico() {
  document.getElementById('histContagem').textContent = `${state.leituras.length} registro${state.leituras.length === 1 ? '' : 's'}`;
  const linhas = state.leituras
    .slice(0, 40)
    .map((l) => {
      const pill =
        l.tipo === 'ok'
          ? '<span class="pill ok">Concluído</span>'
          : l.tipo === 'nok'
          ? '<span class="pill nok">Retrabalho</span>'
          : '<span class="pill neu">Anomalia</span>';
      return `<tr><td class="num">${horaDe(l.criadoEm)}</td><td>${POSTOS[l.posto].nome}</td><td>${l.usuario || '—'}</td><td>${pill}</td></tr>`;
    })
    .join('');
  document.getElementById('histBody').innerHTML =
    linhas || `<tr><td colspan="4" class="vazio">Nenhuma leitura gravada ainda.<br><button type="button" class="vazio-cta" data-action="ir-leitura" data-posto="0">Ir escanear a primeira etiqueta →</button></td></tr>`;
}
function renderAnomalias() {
  document.getElementById('anomContagem').textContent = `${state.anomaliasAbertas.length} aberta${state.anomaliasAbertas.length === 1 ? '' : 's'}`;
  if (!state.anomaliasAbertas.length) {
    document.getElementById('anomBody').innerHTML = `<tr><td colspan="2" class="vazio">Nenhuma anomalia em aberto.</td></tr>`;
    return;
  }
  document.getElementById('anomBody').innerHTML = state.anomaliasAbertas
    .map(
      (a) => `
    <tr><td>${POSTOS[a.posto].nome}</td><td><div class="anom-row"><span>${a.desc}</span>
      <button class="anom-x" title="Resolver" aria-label="Resolver anomalia no ${POSTOS[a.posto].nome}" data-action="resolver-anomalia" data-id="${a.id}">×</button></div></td></tr>
  `
    )
    .join('');
}
async function resolverAnomalia(id) {
  try {
    await state.db.doc('anomalias/' + id).update({ resolvidoEm: new Date().toISOString(), resolvidoPor: state.currentUser.nome });
    toast('Anomalia marcada como resolvida', 'ok');
  } catch (err) {
    toast('Não deu pra resolver agora, tente de novo', 'nok');
  }
}

/* =========================================================
   LEITURA / CÂMERA
   ========================================================= */
function renderPassos() {
  const etapa = state.pendingLeitura ? 2 : state.scannerAtivo ? 1 : 0;
  const passos = [
    { n: 1, t: 'Ligue a câmera' },
    { n: 2, t: 'Escaneie a etiqueta' },
    { n: 3, t: 'Decida o resultado' },
  ];
  document.getElementById('passos').innerHTML = passos
    .map(
      (p, i) => `
    <span class="passo ${i === etapa ? 'ativo' : i < etapa ? 'feito' : ''}"><b>${i < etapa ? '✓' : p.n}</b>${p.t}</span>
    ${i < passos.length - 1 ? '<span class="sep">›</span>' : ''}
  `
    )
    .join('');
}
function renderLeituraCabecalho() {
  if (!state.currentUser) return;
  document.getElementById('lp-posto').textContent = state.currentUser.nome;
  document.getElementById('lp-sub').textContent =
    state.currentUser.posto === null || state.currentUser.posto === undefined
      ? 'Escaneie a etiqueta de qualquer posto'
      : POSTOS[state.currentUser.posto].nome + '';
}
function renderInfoPostoOperador() {
  const el = document.getElementById('operadorInfoPosto');
  if (!el) return;
  if (!state.modoOperador || !state.currentUser || state.currentUser.posto === null || state.currentUser.posto === undefined) {
    el.hidden = true;
    return;
  }
  const i = state.currentUser.posto;
  const p = POSTOS[i];
  const cmins = leiturasDoPosto(state.leituras, i).map((l) => l.cmin);
  const m = mediaPosto(state.leituras, i) || p.base;
  const temDados = cmins.length > 0;
  const fora = posEstaForaDoPadrao(state.leituras, i);
  el.hidden = false;
  el.innerHTML = `
    <div class="p-cab" style="margin-bottom:8px"><span class="dot" style="background:${fora ? 'var(--nok)' : 'var(--ok)'}"></span><span style="font-weight:700">${p.nome} — o que já foi lido nesta rodada</span></div>
    <div class="medida"><span class="v num">${temDados ? m : '—'}</span><span class="u">cmin (média)</span></div>
    <div class="alvo">objetivo ${p.objetivo} cmin</div>
    ${sparklineSVG(cmins, p.objetivo)}
  `;
}

document.getElementById('btnLigarCam').addEventListener('click', ligarCamera);
document.getElementById('btnTrocarCam').addEventListener('click', async () => {
  if (!state.scanner) return;
  try {
    const novaFacing = state.scanner._facingAtual === 'environment' ? 'user' : 'environment';
    await state.scanner.setCamera(novaFacing);
    state.scanner._facingAtual = novaFacing;
  } catch (err) {
    toast('Não consegui trocar de câmera neste aparelho', 'nok');
  }
});

async function ligarCamera() {
  if (state.pendingLeitura) return;
  const video = document.getElementById('video');
  try {
    if (typeof QrScanner === 'undefined') throw new Error('lib ausente');
    QrScanner.WORKER_PATH = 'https://cdnjs.cloudflare.com/ajax/libs/qr-scanner/1.4.2/qr-scanner-worker.min.js';
    if (!state.scanner) {
      state.scanner = new QrScanner(video, (resultado) => onQrDetectado(resultado.data || resultado), {
        returnDetailedScanResult: true,
        highlightScanRegion: false,
        highlightCodeOutline: false,
      });
      state.scanner._facingAtual = 'environment';
    }
    await state.scanner.start();
    state.scannerAtivo = true;
    video.hidden = false;
    document.getElementById('quadroParado').hidden = true;
    document.getElementById('quadroPronto').hidden = true;
    document.getElementById('quadroScan').hidden = false;
    document.getElementById('visorStatus').hidden = false;
    document.getElementById('visorStatus').textContent = 'Aponte para o QR Code da etiqueta';
    document.getElementById('btnTrocarCam').hidden = false;
    renderPassos();
  } catch (err) {
    toast('Não consegui acessar a câmera. Use o campo manual abaixo.', 'nok');
  }
}
function pararScanner() {
  if (state.scanner && state.scannerAtivo) {
    try {
      state.scanner.stop();
    } catch (e) {
      /* scanner já parado — segue */
    }
  }
  state.scannerAtivo = false;
  const video = document.getElementById('video');
  video.hidden = true;
  if (!state.pendingLeitura) document.getElementById('quadroParado').hidden = false;
  document.getElementById('quadroScan').hidden = true;
  document.getElementById('visorStatus').hidden = true;
  document.getElementById('btnTrocarCam').hidden = true;
}

document.getElementById('btnManual').addEventListener('click', () => {
  const val = document.getElementById('manualCodigo').value.trim();
  if (!val) return;
  onQrDetectado(val);
  document.getElementById('manualCodigo').value = '';
});

function onQrDetectado(texto) {
  if (state.pendingLeitura) return;
  const postoIdx = extrairPostoDeTexto(texto);
  if (postoIdx === null) {
    toast('QR Code não reconhecido pelo Lean Lab', 'nok');
    return;
  }
  if (state.modoOperador && postoIdx !== state.currentUser.posto) {
    toast(`Essa etiqueta é do ${POSTOS[postoIdx].nome} — você entrou no ${POSTOS[state.currentUser.posto].nome}.`, 'nok');
    return;
  }
  if (state.scannerAtivo) {
    try {
      state.scanner.stop();
    } catch (e) {
      /* scanner já parado — segue */
    }
    state.scannerAtivo = false;
  }
  document.getElementById('visorStatus').textContent = 'Etiqueta lida — calculando…';
  setTimeout(() => {
    const cmin = gerarCmin(postoIdx);
    state.pendingLeitura = { posto: postoIdx, cmin, parte: PARTES[postoIdx] };
    renderResultado();
  }, 450);
}

function renderResultado() {
  const btnConcluir = document.getElementById('btnConcluir');
  const btnRetrabalho = document.getElementById('btnRetrabalho');
  const btnAnomalia = document.getElementById('btnAnomalia');
  const resultadoBox = document.getElementById('resultadoBox');
  const quadroScan = document.getElementById('quadroScan');
  const visorStatus = document.getElementById('visorStatus');
  const video = document.getElementById('video');

  if (!state.pendingLeitura) {
    resultadoBox.innerHTML = `<div class="semleitura">Nenhuma leitura feita ainda. Ligue a câmera e escaneie uma etiqueta.</div>`;
    btnConcluir.disabled = true;
    btnRetrabalho.disabled = true;
    btnAnomalia.disabled = true;
    document.getElementById('quadroPronto').hidden = true;
    renderPassos();
    return;
  }
  const p = POSTOS[state.pendingLeitura.posto];
  const parte = state.pendingLeitura.parte;
  const fora = state.pendingLeitura.cmin > p.objetivo * 1.05;
  resultadoBox.innerHTML = `
    <div class="c mono">${parte.ref}${tipHtml('tipCmin', 'cmin = centésimos de minuto, a unidade usada pra medir o tempo de ciclo.')}</div>
    <div class="d">${parte.nome} · ${p.nome}</div>
    <div class="linhaRes">
      <div class="medido ${fora ? 'fora' : ''} num">${state.pendingLeitura.cmin}<u>cmin medidos</u></div>
      <div class="objref">objetivo FOS<b class="num">${p.objetivo} cmin</b></div>
    </div>
    <span class="tagres ${fora ? 'fora' : 'ok'}">${fora ? 'acima do objetivo' : 'dentro do objetivo'}</span>
  `;
  btnConcluir.disabled = false;
  btnRetrabalho.disabled = false;
  btnAnomalia.disabled = false;
  video.hidden = true;
  quadroScan.hidden = true;
  visorStatus.hidden = true;
  document.getElementById('quadroParado').hidden = true;
  document.getElementById('quadroPronto').hidden = false;
  renderPassos();
}

async function gravarLeitura(tipo, desc) {
  if (!state.pendingLeitura || !state.db) return;
  const payload = {
    posto: state.pendingLeitura.posto,
    parteRef: state.pendingLeitura.parte.ref,
    parteNome: state.pendingLeitura.parte.nome,
    cmin: state.pendingLeitura.cmin,
    objetivo: POSTOS[state.pendingLeitura.posto].objetivo,
    tipo,
    usuario: state.currentUser.nome,
    criadoEm: new Date().toISOString(),
  };
  if (desc) payload.desc = desc;
  try {
    await state.db.collection('leituras').add(payload);
    if (tipo === 'anomalia') {
      await state.db.collection('anomalias').add({
        posto: state.pendingLeitura.posto,
        desc,
        usuario: state.currentUser.nome,
        criadoEm: new Date().toISOString(),
        resolvidoEm: null,
      });
    }
    const msgs = {
      ok: `${POSTOS[state.pendingLeitura.posto].nome}: operação concluída em ${state.pendingLeitura.cmin} cmin`,
      nok: `${POSTOS[state.pendingLeitura.posto].nome}: retrabalho registrado`,
      anomalia: 'Anomalia 5S registrada com foto',
    };
    toast(msgs[tipo], tipo === 'ok' ? 'ok' : 'nok');
  } catch (err) {
    toast('Não deu pra gravar agora (' + ((err && err.code) || 'erro') + '). Tente de novo.', 'nok');
    return;
  }
  state.pendingLeitura = null;
  renderResultado();
  document.getElementById('quadroParado').hidden = false;
  setTimeout(ligarCamera, 350);
}
document.getElementById('btnConcluir').addEventListener('click', () => gravarLeitura('ok'));
document.getElementById('btnRetrabalho').addEventListener('click', () => gravarLeitura('nok'));
document.getElementById('btnAnomalia').addEventListener('click', abrirModalAnomalia);

/* modal anomalia */
function abrirModalAnomalia() {
  if (!state.pendingLeitura) return;
  state.modalCtx = { posto: state.pendingLeitura.posto };
  document.getElementById('modalSub').textContent = `Posto selecionado: ${POSTOS[state.pendingLeitura.posto].nome}. Descreva o que foi observado.`;
  const input = document.getElementById('modalInput');
  input.value = '';
  document.getElementById('modalBackdrop').classList.add('show');
  setTimeout(() => input.focus(), 50);
}
function fecharModal() {
  document.getElementById('modalBackdrop').classList.remove('show');
  state.modalCtx = null;
}
document.getElementById('modalCancelar').addEventListener('click', fecharModal);
document.getElementById('modalConfirmar').addEventListener('click', () => {
  if (!state.modalCtx) return;
  const input = document.getElementById('modalInput');
  const desc = input.value.trim() || 'Anomalia registrada sem descrição';
  fecharModal();
  gravarLeitura('anomalia', desc);
});
document.getElementById('modalBackdrop').addEventListener('click', (e) => {
  if (e.target.id === 'modalBackdrop') fecharModal();
});
document.getElementById('modalInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('modalConfirmar').click();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.getElementById('modalBackdrop').classList.contains('show')) fecharModal();
  if (document.getElementById('ajudaBackdrop').classList.contains('show')) fecharAjuda();
  if (document.getElementById('tourBackdrop').classList.contains('show')) fecharTour();
});

/* =========================================================
   RENDER — RELATÓRIO
   ========================================================= */
function renderGrafico() {
  const maxEscala = TAKT * 1.25;
  let cols = '<div class="takt" style="bottom:' + Math.round((TAKT / maxEscala) * 100) + '%"><span>takt ' + TAKT + '</span></div>';
  let rots = '';
  POSTOS.forEach((p, i) => {
    const m = mediaPosto(state.leituras, i) || p.base;
    const fora = posEstaForaDoPadrao(state.leituras, i);
    const hB = Math.round((m / maxEscala) * 100);
    const hAlvo = Math.round((p.objetivo / maxEscala) * 100);
    cols += `<div class="col ${fora ? 'fora' : ''}"><div class="alvo-m" style="bottom:${hAlvo}%"></div><div class="b" style="height:${hB}%"><em class="num">${m}</em></div></div>`;
    rots += `<div>${p.nome}</div>`;
  });
  document.getElementById('graf').innerHTML = cols;
  document.getElementById('rots').innerHTML = rots;
}
/** Série histórica de aderência/lead-time, ponto a ponto, à medida que as leituras foram entrando (ordem cronológica). */
function historicoIndicadores() {
  const asc = state.leituras.slice().sort((a, b) => (a.criadoEm < b.criadoEm ? -1 : 1));
  const pontos = [];
  let dentro = 0;
  let total = 0;
  const porPosto = POSTOS.map(() => []);
  asc.forEach((l) => {
    total++;
    if (l.cmin <= POSTOS[l.posto].objetivo * 1.05) dentro++;
    porPosto[l.posto].push(l.cmin);
    const somaMedias = POSTOS.reduce((a, p, i) => a + (media(porPosto[i]) || p.base), 0);
    pontos.push({ aderencia: Math.round((100 * dentro) / total), leadTime: (somaMedias / 100) * 2.3 });
  });
  return pontos;
}
function renderTendencias() {
  const pontos = historicoIndicadores();
  const aderencias = [BASELINE.aderencia, ...pontos.map((p) => p.aderencia)];
  const leadTimes = [BASELINE.leadTime, ...pontos.map((p) => p.leadTime)];
  const svgA = trendSVG(aderencias, '#1E874B');
  const svgL = trendSVG(leadTimes, '#004C97');
  document.getElementById('tendAderenciaSvg').outerHTML = svgA
    ? svgA.replace('<svg', '<svg id="tendAderenciaSvg" preserveAspectRatio="none"')
    : '<svg id="tendAderenciaSvg" viewBox="0 0 300 64"></svg>';
  document.getElementById('tendLeadSvg').outerHTML = svgL
    ? svgL.replace('<svg', '<svg id="tendLeadSvg" preserveAspectRatio="none"')
    : '<svg id="tendLeadSvg" viewBox="0 0 300 64"></svg>';
  document.getElementById('tendAderenciaAgora').textContent = aderenciaFOS(state.leituras) + '%';
  document.getElementById('tendLeadAgora').textContent = fmt1(leadTimeMedioEstimado(state.leituras)) + ' min';
}
function renderNarrativa() {
  const idxRestritivo = indiceRestritivo(state.leituras);
  const restritivo = POSTOS[idxRestritivo];
  const wipMax = Math.max(0, ...POSTOS.slice(0, -1).map((_, i) => wipDoPosto(state.leituras, i)));
  const total = state.leituras.length;
  if (!total) {
    document.getElementById('narrativaTexto').innerHTML =
      '<p>Ainda não há leituras gravadas. Vá em "Ler QR Code" e escaneie a primeira etiqueta pra o relatório começar a se montar sozinho.</p>';
    return;
  }
  document.getElementById('narrativaTexto').innerHTML = `
    <p>O ${restritivo.nome} é hoje o posto restritivo da linha, com tempo de ciclo médio de ${mediaPosto(state.leituras, idxRestritivo) || restritivo.base} cmin frente a um objetivo de ${restritivo.objetivo}.</p>
    <p>Foram gravadas ${total} leituras no banco de dados, com ${totalRetrabalho(state.leituras)} retrabalho${totalRetrabalho(state.leituras) === 1 ? '' : 's'} e o maior estoque em processo em ${wipMax} peça${wipMax === 1 ? '' : 's'}.</p>
    <p>A aderência à FOS está em ${aderenciaFOS(state.leituras)}%, com lead time médio de ${fmt1(leadTimeMedioEstimado(state.leituras))} minutos e ${totalConcluidos(state.leituras)} soletrons concluídos até agora.</p>
  `;
}

/* =========================================================
   ETIQUETAS QR
   ========================================================= */
/**
 * URL que vai dentro do QR Code: um link de verdade pro próprio app, com
 * ?posto=N. Assim, se alguém escanear a etiqueta com a câmera comum do
 * celular (fora do app), o link abre esta página já reconhecendo o posto —
 * em vez de mostrar só um texto solto, que o celular manda pro Bloco de
 * Notas / apps de anotação por não ser uma URL.
 */
function urlDoPosto(i) {
  return location.origin + location.pathname + '?posto=' + (i + 1);
}
function renderQrGrid() {
  const grid = document.getElementById('qrGrid');
  grid.innerHTML = POSTOS.map(
    (p, i) => `
    <div class="qr-card">
      <div class="canvasbox" id="qrBox${i}"></div>
      <div class="nome">${p.nome}</div>
      <div class="ref">${PARTES[i].nome}</div>
      <div class="cod mono">LEANLAB-POSTO-${i + 1}</div>
      <button class="btn-baixar" type="button" data-action="baixar-qr" data-posto="${i}">Baixar PNG</button>
    </div>
  `
  ).join('');
  POSTOS.forEach((p, i) => {
    if (typeof QRCode === 'undefined') return;
    new QRCode(document.getElementById('qrBox' + i), {
      text: urlDoPosto(i),
      width: 148,
      height: 148,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  });
}
async function baixarQr(i) {
  const box = document.getElementById('qrBox' + i);
  const canvas = box && box.querySelector('canvas');
  if (!canvas) {
    toast('QR Code ainda não carregou, tente de novo', 'nok');
    return;
  }
  try {
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = 'etiqueta-posto-' + (i + 1) + '.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    toast('Não deu pra baixar agora', 'nok');
  }
}

/* =========================================================
   CADASTRO DE PESSOAS (coordenador) — por posto
   ========================================================= */
function renderPostoOptionsCadastro() {
  const sel = document.getElementById('cadPosto');
  if (!sel) return;
  sel.innerHTML = POSTOS.map((p, i) => `<option value="${i}">${p.nome}</option>`).join('');
}
renderPostoOptionsCadastro();

document.getElementById('formCadastroPessoa').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nome = document.getElementById('cadNome').value.trim();
  const posto = Number(document.getElementById('cadPosto').value) || 0;
  if (!nome || !state.db) return;
  try {
    await state.db.collection('pessoas').add({ nome, posto, criadoEm: new Date().toISOString() });
    document.getElementById('cadNome').value = '';
    toast(`${nome} cadastrado(a) no ${POSTOS[posto].nome}`, 'ok');
    renderPessoasCadastro();
  } catch (err) {
    toast('Não deu pra cadastrar agora, tente de novo', 'nok');
  }
});

async function renderPessoasCadastro() {
  const body = document.getElementById('pessoasBody');
  if (!body || !state.db) return;
  try {
    const snap = await state.db.collection('pessoas').get();
    const pessoas = snap.docs
      .map((d) => Object.assign({ id: d.id }, d.data()))
      .sort((a, b) => a.posto - b.posto || (a.nome || '').localeCompare(b.nome || ''));
    const contagem = document.getElementById('pessoasContagem');
    if (contagem) contagem.textContent = pessoas.length;
    body.innerHTML = pessoas.length
      ? pessoas
          .map(
            (p) => `
      <tr><td>${p.nome}</td><td>${POSTOS[p.posto] ? POSTOS[p.posto].nome : '—'}</td>
      <td><button class="anom-x" title="Remover" aria-label="Remover ${p.nome}" data-action="remover-pessoa" data-id="${p.id}">×</button></td></tr>
    `
          )
          .join('')
      : `<tr><td colspan="3" class="vazio">Nenhuma pessoa cadastrada ainda.</td></tr>`;
  } catch (err) {
    body.innerHTML = `<tr><td colspan="3" class="vazio">Não consegui carregar agora.</td></tr>`;
  }
}
async function removerPessoa(id) {
  try {
    await state.db.doc('pessoas/' + id).delete();
    toast('Pessoa removida', 'ok');
    renderPessoasCadastro();
  } catch (err) {
    toast('Não deu pra remover agora', 'nok');
  }
}

/* =========================================================
   NAVEGAÇÃO (abas acessíveis)
   ========================================================= */
function ir(i, btn) {
  document.querySelectorAll('.tela').forEach((s, n) => (s.hidden = n !== i));
  document.querySelectorAll('nav.tabsnav button').forEach((b) => {
    b.setAttribute('aria-selected', 'false');
    b.tabIndex = -1;
  });
  btn.setAttribute('aria-selected', 'true');
  btn.tabIndex = 0;
  if (i !== 1) pararScanner();
  window.scrollTo({ top: 0 });
}
function tabKeydown(e, i) {
  const botoes = Array.from(document.querySelectorAll('nav.tabsnav button'));
  let alvo = null;
  if (e.key === 'ArrowRight') alvo = botoes[(i + 1) % botoes.length];
  else if (e.key === 'ArrowLeft') alvo = botoes[(i - 1 + botoes.length) % botoes.length];
  else if (e.key === 'Home') alvo = botoes[0];
  else if (e.key === 'End') alvo = botoes[botoes.length - 1];
  if (!alvo) return;
  e.preventDefault();
  const idx = botoes.indexOf(alvo);
  ir(idx, alvo);
  alvo.focus();
}

function renderTudo() {
  renderTrilho();
  renderInds();
  renderHistorico();
  renderGrafico();
  renderTendencias();
  renderNarrativa();
  renderInfoPostoOperador();
}

/* =========================================================
   DELEGAÇÃO DE EVENTOS
   =========================================================
   Como o script roda como módulo (type="module"), suas funções não ficam
   expostas em `window` automaticamente — então atributos como
   `onclick="minhaFuncao()"` no HTML deixariam de funcionar. Em vez disso,
   os elementos gerados dinamicamente (cards de posto, botões de anomalia,
   QR Codes, tooltips…) carregam um `data-action` e o clique é escutado uma
   única vez, no `document`, e despachado daqui — a mesma técnica usada por
   qualquer framework de UI moderno por baixo dos panos. */
document.addEventListener('click', (e) => {
  const alvo = e.target.closest('[data-action]');
  if (!alvo) return;
  const acao = alvo.dataset.action;
  if (acao === 'tab') {
    ir(Number(alvo.dataset.tabIdx), alvo);
  } else if (acao === 'toggle-tip') {
    toggleTip(alvo);
  } else if (acao === 'ir-leitura') {
    irParaLeitura(Number(alvo.dataset.posto));
  } else if (acao === 'resolver-anomalia') {
    resolverAnomalia(alvo.dataset.id);
  } else if (acao === 'baixar-qr') {
    baixarQr(Number(alvo.dataset.posto));
  } else if (acao === 'remover-pessoa') {
    removerPessoa(alvo.dataset.id);
  }
});
/* Navegação por teclado das abas (setas / Home / End) — delegada no <nav>. */
document.querySelector('nav.tabsnav').addEventListener('keydown', (e) => {
  const btn = e.target.closest('button[data-tab-idx]');
  if (!btn) return;
  tabKeydown(e, Number(btn.dataset.tabIdx));
});
/* Ativar um card de posto do painel por teclado (Enter / Espaço) — delegada no trilho. */
document.getElementById('trilho').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const card = e.target.closest('[data-action="ir-leitura"]');
  if (!card) return;
  e.preventDefault();
  irParaLeitura(Number(card.dataset.posto));
});

/* =========================================================
   INICIALIZAÇÃO DO BANCO DE DADOS
   ========================================================= */
(async () => {
  const { db, real } = await iniciarBancoDeDados();
  state.db = db;
  const status = document.getElementById('dbStatus');
  if (status) {
    status.textContent = real
      ? 'Conectado ao Firebase — os dados ficam salvos de verdade e sincronizam entre aparelhos.'
      : 'Modo local (preencha js/firebase-config.js pra ligar o Firebase): os dados ficam só neste navegador, sem sincronizar com outros aparelhos.';
  }
})();
