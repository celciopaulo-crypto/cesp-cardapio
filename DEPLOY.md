# Deploy — CESP Food (Worker + KV)

Armazenamento central partilhado do catálogo e dos pedidos, sobre um único
Cloudflare Worker que também serve os ficheiros estáticos (`index.html`,
`admin.html`, `pos.html`).

## O que isto resolve

Antes: cada dispositivo tinha o seu próprio `localStorage` — o menu editado no
admin (PC) não aparecia no telemóvel do cliente. Agora o **catálogo** é
publicado no KV e lido por todos; os **pedidos** online caem numa fila central
que o admin e o POS leem em qualquer dispositivo.

## Pré-requisitos

- Conta Cloudflare + `npx wrangler` (vem com Node). Login: `npx wrangler login`.

## Passos (primeira vez)

```bash
# 1) Criar o namespace KV
npx wrangler kv namespace create CESP_KV
#   → copia o "id" devolvido para wrangler.toml, em [[kv_namespaces]].id
#     (substituir <KV_NAMESPACE_ID>)

# 2) Definir a chave secreta de escrita (a MESMA que se introduz no admin/POS)
npx wrangler secret put PUBLISH_TOKEN
#   → escolhe uma chave forte (ex.: gerada aleatoriamente). NÃO fica no git.

# 3) Publicar
npx wrangler deploy
```

No fim, o Worker fica em `https://cesp-cardapio.<subdominio>.workers.dev`
(ou no domínio próprio, se configurado — ex.: `https://cespfood.com`).

## Primeira utilização no admin e no POS

Ao abrir `admin.html` (e `pos.html`) pela primeira vez em cada dispositivo, é
pedida **uma vez** a chave — introduz exatamente o valor definido em
`PUBLISH_TOKEN`. Fica guardada nesse dispositivo (`localStorage`).
Para trocar/limpar: na consola do browser,
`localStorage.removeItem('cesp_publish_token')` e recarregar.

O `index.html` (cardápio do cliente) **não** pede chave — o catálogo é público
e os pedidos entram sem autenticação, como no checkout normal.

## Endpoints servidos pelo Worker (`/api/*`)

| Endpoint | Método | Auth | Função |
|---|---|---|---|
| `/api/catalogo.php` | GET | pública | Lê o menu publicado |
| `/api/publicar.php` | POST | token | Admin publica o menu |
| `/api/pedido.php` | POST | pública | Cliente cria pedido online |
| `/api/pedidos.php` | GET | token | Admin/POS listam pedidos (`?desde=`, `?historico=1`) |
| `/api/pedido-estado.php` | POST | token | Mudar estado do pedido |
| `/api/pagamento.php` | POST | token | Confirmar/rejeitar pagamento |
| `/api/comprovativo.php` | GET | token | Ver comprovativo de um pedido |
| `/api/estatisticas.php` | GET | token | Agregado de clientes |

## Modelo de dados no KV

- `catalogo` — JSON do menu (o mesmo payload que o admin já enviava).
- `catalogo_ts` — timestamp da última publicação.
- `pedido:<uuid>` — **um pedido por chave** (escritas nunca colidem; reenvio
  é idempotente por id).
- `contador` — número de pedido (best-effort).

## Limites assumidos (âmbito desta fase)

- **Numeração fiscal garantida NÃO está incluída.** O `numero` do pedido é uma
  referência operacional best-effort. Numeração sequencial legal (Fase 4) exige
  escrita atómica → Durable Object ou D1.
- **KV é eventualmente consistente:** publicar o menu pode levar de segundos a
  ~1 min a propagar globalmente. Aceitável para um menu.
- Vendas de balcão, caixa, turnos e mesas do POS continuam **locais** (fora de
  âmbito desta fase; só catálogo e pedidos online são partilhados).
