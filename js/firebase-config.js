/**
 * Credenciais do projeto Firebase usado como banco de dados (Firestore).
 *
 * Troque os valores abaixo pelos do SEU projeto:
 * console.firebase.google.com → criar projeto → Compilação → Firestore
 * Database → criar banco → ⚙️ Configurações do projeto → no cartão do
 * app da Web, o trecho "firebaseConfig" é exatamente este objeto.
 *
 * Esses valores não são segredo — ficam expostos no código do site de
 * qualquer jeito, é assim que um app Firebase funciona no navegador.
 * Quem protege os dados são as Regras de segurança do Firestore,
 * configuradas no console (veja o README).
 *
 * Sem uma configuração válida aqui, o app cai automaticamente para um
 * banco local no navegador (ver js/db.js) — dá pra testar tudo antes de
 * preencher isto.
 */
export const firebaseConfig = {
  apiKey: 'COLE_AQUI_SUA_API_KEY',
  authDomain: 'seu-projeto.firebaseapp.com',
  projectId: 'seu-projeto',
  storageBucket: 'seu-projeto.appspot.com',
  messagingSenderId: '000000000000',
  appId: '1:000000000000:web:xxxxxxxxxxxxxxxxxxxxxx',
};
