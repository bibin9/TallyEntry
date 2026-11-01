// Cloudflare Worker entry (used when the project is deployed as a Worker, see wrangler.jsonc).
// /api/* goes to the sync API; everything else is the app, served from the app/ folder.
import { handleApi } from '../server/api.js';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api' || pathname.startsWith('/api/')) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
};
