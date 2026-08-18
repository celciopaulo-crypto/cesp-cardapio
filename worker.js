/* ============================================================
   CESP Food — Worker de armazenamento central partilhado
   ------------------------------------------------------------
   Fase 0/3-lite: catálogo partilhado (todos os dispositivos leem
   o mesmo menu) + pedidos online partilhados, sobre Cloudflare KV.

   Serve os endpoints que os três ficheiros (index/admin/pos) JÁ
   chamam — por isso os caminhos mantêm o sufixo .php (legado; é
   só uma string de rota, não há PHP aqui).

   Bindings esperados (ver wrangler.toml):
     - env.CESP_KV        → KV namespace (dados)
     - env.PUBLISH_TOKEN  → segredo (Worker secret) p/ escrita
     - env.ASSETS         → ficheiros estáticos (index/admin/pos…)

   Modelo de dados no KV:
     - catalogo            → JSON do menu publicado pelo admin
     - catalogo_ts         → timestamp da última publicação
     - contador            → contador do nº de pedido (best-effort)
     - pedido:<uuid>       → um pedido por chave (sem colisão de escrita)

   NOTA DE ÂMBITO: o KV não tem escrita atómica. Por isso cada
   pedido é a sua PRÓPRIA chave (escritas nunca se sobrepõem) e o
   reenvio é idempotente por id. O nº sequencial do pedido é
   best-effort — numeração fiscal garantida é Fase 4 (Durable
   Object/D1), não se promete aqui.
   ============================================================ */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: JSON_HEADERS });
}

/* Data/hora local de Angola (WAT, UTC+1, sem horário de verão),
   no formato 'YYYY-MM-DD HH:MM:SS' que os clientes já esperam. */
function agoraWAT() {
  const d = new Date(Date.now() + 60 * 60 * 1000); // UTC+1
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/* Token esperado: primeiro o Worker secret (PUBLISH_TOKEN); se não
   existir, uma chave guardada no próprio KV (config:publish_token).
   O fallback por KV é fiável e editável à mão no painel da Cloudflare
   (página "Pares de KV"), sem depender dos segredos do Worker. */
async function tokenEsperado(env) {
  const s = (env.PUBLISH_TOKEN || '').trim();
  if (s) return s;
  try {
    const k = await env.CESP_KV.get('config:publish_token');
    if (k) return k.trim();
  } catch (e) {}
  return '';
}

async function autorizado(request, env) {
  const esperado = await tokenEsperado(env);
  const t = (request.headers.get('X-CESP-Token') || '').trim();
  return !!esperado && t === esperado;
}

/* ── Catálogo ───────────────────────────────────────────── */
async function getCatalogo(env) {
  const raw = await env.CESP_KV.get('catalogo');
  const ts = await env.CESP_KV.get('catalogo_ts');
  if (!raw) return json({ ok: true, catalogo: null, ts: ts || null });
  let cat;
  try { cat = JSON.parse(raw); } catch (e) { cat = null; }
  return json({ ok: true, catalogo: cat, ts: ts || null });
}

async function publicar(request, env) {
  if (!(await autorizado(request, env))) return json({ ok: false, erro: 'nao_autorizado' }, 401);
  let payload;
  try { payload = await request.text(); } catch (e) { return json({ ok: false, erro: 'corpo_invalido' }, 400); }
  try { JSON.parse(payload); } catch (e) { return json({ ok: false, erro: 'json_invalido' }, 400); }
  const ts = Date.now().toString();
  await env.CESP_KV.put('catalogo', payload);
  await env.CESP_KV.put('catalogo_ts', ts);
  return json({ ok: true, ts });
}

/* ── Pedidos ────────────────────────────────────────────── */
async function proximoNumero(env) {
  // Best-effort (sem atomicidade no KV). Idempotência do pedido
  // é garantida pela chave por-id; o nº é só referência operacional.
  let n = parseInt((await env.CESP_KV.get('contador')) || '0', 10);
  if (isNaN(n)) n = 0;
  n = n + 1;
  await env.CESP_KV.put('contador', String(n));
  return n;
}

async function criarPedido(request, env) {
  let p;
  try { p = await request.json(); } catch (e) { return json({ ok: false, erro: 'json_invalido' }, 400); }
  if (!p || !p.id) return json({ ok: false, erro: 'sem_id' }, 400);

  const chave = 'pedido:' + p.id;
  const existente = await env.CESP_KV.get(chave);
  if (existente) {
    // Reenvio idempotente: devolve o número já atribuído, não duplica.
    let ex; try { ex = JSON.parse(existente); } catch (e) { ex = {}; }
    return json({ ok: true, numero: ex.numero, repetido: true });
  }

  const numero = await proximoNumero(env);
  const criado = agoraWAT();
  const pagamento_estado =
    (p.pagamento === 'transferencia' && p.comprovativo) ? 'pendente' : 'nao_aplicavel';

  const pedido = Object.assign({}, p, {
    numero: numero,
    estado: 'novo',
    criado: criado,
    criado_em: criado,          // admin usa criado_em; incluímos ambos
    pagamento_estado: pagamento_estado
  });

  await env.CESP_KV.put(chave, JSON.stringify(pedido));
  return json({ ok: true, numero: numero });
}

async function listarPedidos(request, env, url) {
  if (!(await autorizado(request, env))) return json({ ok: false, erro: 'nao_autorizado' }, 401);

  const desde = url.searchParams.get('desde');           // 'YYYY-MM-DD'
  const historico = url.searchParams.get('historico');   // '1'

  const lista = await env.CESP_KV.list({ prefix: 'pedido:' });
  const pedidos = [];
  for (const k of lista.keys) {
    const raw = await env.CESP_KV.get(k.name);
    if (!raw) continue;
    let o; try { o = JSON.parse(raw); } catch (e) { continue; }

    // Filtro por período
    const dataPedido = String(o.criado_em || o.criado || '').slice(0, 10);
    if (desde && dataPedido && dataPedido < desde) continue;

    // Fila "ativa" (sem parâmetros): esconde concluídos/cancelados
    if (!desde && !historico) {
      if (o.estado === 'entregue' || o.estado === 'cancelado') continue;
    }

    // Aligeira a lista: o comprovativo (pode ser grande) só via comprovativo.php
    const copia = Object.assign({}, o);
    if (copia.comprovativo) copia.comprovativo = true; // marca que existe, sem enviar o dataURL
    pedidos.push(copia);
  }

  // Mais recentes primeiro
  pedidos.sort(function (a, b) {
    return String(b.criado_em || '').localeCompare(String(a.criado_em || ''));
  });

  return json({ ok: true, pedidos: pedidos });
}

async function mudarEstado(request, env) {
  if (!(await autorizado(request, env))) return json({ ok: false, erro: 'nao_autorizado' }, 401);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false, erro: 'json_invalido' }, 400); }
  if (!body || !body.id || !body.estado) return json({ ok: false, erro: 'parametros' }, 400);

  const chave = 'pedido:' + body.id;
  const raw = await env.CESP_KV.get(chave);
  if (!raw) return json({ ok: false, erro: 'nao_encontrado' }, 404);
  let o; try { o = JSON.parse(raw); } catch (e) { return json({ ok: false, erro: 'corrompido' }, 500); }

  o.estado = body.estado;
  await env.CESP_KV.put(chave, JSON.stringify(o));
  return json({ ok: true, estado: o.estado });
}

async function mudarPagamento(request, env) {
  if (!(await autorizado(request, env))) return json({ ok: false, erro: 'nao_autorizado' }, 401);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false, erro: 'json_invalido' }, 400); }
  if (!body || !body.id || !body.estado) return json({ ok: false, erro: 'parametros' }, 400);

  const chave = 'pedido:' + body.id;
  const raw = await env.CESP_KV.get(chave);
  if (!raw) return json({ ok: false, erro: 'nao_encontrado' }, 404);
  let o; try { o = JSON.parse(raw); } catch (e) { return json({ ok: false, erro: 'corrompido' }, 500); }

  o.pagamento_estado = body.estado;
  await env.CESP_KV.put(chave, JSON.stringify(o));
  return json({ ok: true, pagamento_estado: o.pagamento_estado });
}

async function verComprovativo(request, env, url) {
  if (!(await autorizado(request, env))) return json({ ok: false, erro: 'nao_autorizado' }, 401);
  const id = url.searchParams.get('id');
  if (!id) return json({ ok: false, erro: 'sem_id' }, 400);
  const raw = await env.CESP_KV.get('pedido:' + id);
  if (!raw) return json({ ok: false, erro: 'nao_encontrado' }, 404);
  let o; try { o = JSON.parse(raw); } catch (e) { return json({ ok: false, erro: 'corrompido' }, 500); }
  if (!o.comprovativo) return json({ ok: false, erro: 'sem_comprovativo' }, 404);
  return json({ ok: true, comprovativo: o.comprovativo });
}

async function estatisticas(request, env) {
  if (!(await autorizado(request, env))) return json({ ok: false, erro: 'nao_autorizado' }, 401);

  const lista = await env.CESP_KV.list({ prefix: 'pedido:' });
  const map = {};
  for (const k of lista.keys) {
    const raw = await env.CESP_KV.get(k.name);
    if (!raw) continue;
    let o; try { o = JSON.parse(raw); } catch (e) { continue; }
    if (o.estado === 'cancelado') continue;

    const tel = String(o.cliente_telefone || '').trim();
    const nome = String(o.cliente_nome || 'Cliente').trim();
    const chave = tel || ('nome:' + nome.toLowerCase());
    const quando = String(o.criado_em || o.criado || '');

    if (!map[chave]) map[chave] = { nome: nome, telefone: tel, pedidos: 0, total: 0, primeira: quando, ultima: quando };
    const c = map[chave];
    c.pedidos += 1;
    c.total += Number(o.total) || 0;
    if (quando) {
      if (!c.primeira || quando < c.primeira) c.primeira = quando;
      if (!c.ultima || quando > c.ultima) c.ultima = quando;
    }
    if (nome && nome !== 'Cliente') c.nome = nome;
  }

  const clientes = Object.keys(map).map(function (k) { return map[k]; });
  const total_clientes = clientes.length;
  const novos = clientes.filter(function (c) { return c.pedidos <= 1; }).length;
  const recorrentes = clientes.filter(function (c) { return c.pedidos >= 2; }).length;
  const retorno = total_clientes > 0 ? Math.round((recorrentes / total_clientes) * 100) : 0;
  const top_clientes = clientes.slice().sort(function (a, b) { return b.total - a.total; }).slice(0, 10)
    .map(function (c) { return { nome: c.nome, pedidos: c.pedidos, total: c.total }; });

  return json({
    ok: true,
    total_clientes: total_clientes,
    novos: novos,
    recorrentes: recorrentes,
    retorno: retorno,
    top_clientes: top_clientes,
    clientes: clientes
  });
}

/* ── Router ─────────────────────────────────────────────── */
async function handleApi(request, env, url) {
  const path = url.pathname;
  const m = request.method;

  if (path.endsWith('/catalogo.php') && m === 'GET') return getCatalogo(env);
  if (path.endsWith('/publicar.php') && m === 'POST') return publicar(request, env);
  if (path.endsWith('/pedido.php') && m === 'POST') return criarPedido(request, env);
  if (path.endsWith('/pedidos.php') && m === 'GET') return listarPedidos(request, env, url);
  if (path.endsWith('/pedido-estado.php') && m === 'POST') return mudarEstado(request, env);
  if (path.endsWith('/pagamento.php') && m === 'POST') return mudarPagamento(request, env);
  if (path.endsWith('/comprovativo.php') && m === 'GET') return verComprovativo(request, env, url);
  if (path.endsWith('/estatisticas.php') && m === 'GET') return estatisticas(request, env);

  return json({ ok: false, erro: 'endpoint_desconhecido' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        return json({ ok: false, erro: 'erro_interno', detalhe: String(e && e.message || e) }, 500);
      }
    }
    // Tudo o resto: ficheiros estáticos (index.html, admin.html, pos.html…)
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  }
};
