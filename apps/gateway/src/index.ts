/**
 * tela-gateway (ADR 0065): `api.telaread.com`. Built in its own slice; until then it answers
 * nothing but 404.
 */
export default {
  fetch(): Response {
    return new Response('not found', { status: 404 })
  },
}
