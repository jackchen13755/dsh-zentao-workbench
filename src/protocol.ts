/**
 * The wire between the two halves of this plugin — shared by host and browser.
 *
 * Kept dependency-free on purpose: the browser half bundles this file, so it
 * must not pull in anything that reaches Node APIs.
 */

/**
 * Path of the panel transport.
 *
 * Measured on 0.1.7-rc.2 desktop: private RPC channels (`connection.rpc.handle`)
 * are not mounted — a POST to `/zentao/...` is answered by
 * `dsh-host-frontend-static` with 405. What is mounted is the shared `/api`
 * prefix (Host/Origin fence + browser auth), and Connection dispatches **exact
 * Fetch routes under it before** the API gateway's interceptor. That is also how
 * a working plugin on this machine exposes `/api/report`.
 */
export const ZENTAO_FETCH_PATH = '/api/zentao'

/** Request body of one panel call. */
export interface ZentaoCallRequest {
  endpoint: string
  payload?: unknown
}

/** A failed call, as the host reports it (never thrown across the wire). */
export interface ZentaoCallError {
  code: string
  message: string
  details?: unknown
}

export type ZentaoCallResult =
  | { ok: true, value: unknown }
  | { ok: false, error: ZentaoCallError }
