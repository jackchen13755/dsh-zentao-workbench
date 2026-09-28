"use strict";
/**
 * The wire between the two halves of this plugin — shared by host and browser.
 *
 * Kept dependency-free on purpose: the browser half bundles this file, so it
 * must not pull in anything that reaches Node APIs.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ZENTAO_FETCH_PATH = void 0;
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
exports.ZENTAO_FETCH_PATH = '/api/zentao';
