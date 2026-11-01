// Cloudflare Pages Function for /api/* (used when the project is deployed as Cloudflare Pages).
// The API itself is in server/api.js, shared with the Worker entry (worker/index.js).
import { handleApi } from '../../server/api.js';

export const onRequest = ({ request, env }) => handleApi(request, env);
