import { api } from './api.js';
import HTML from '../.build/app.html';
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) {
        const result = await api(request, env);
        if (result instanceof Response) return result;
        return Response.json(result, { headers: { 'cache-control': 'private, no-store' } });
      }
      return new Response(HTML, {
        headers: {
          'content-type': 'text/html;charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
          'content-security-policy':
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors 'self' https://chatgpt.com",
        },
      });
    } catch (error) {
      return Response.json(
        { error: error.status ? error.message : 'Something went wrong. Please retry.' },
        { status: error.status || 500, headers: { 'cache-control': 'no-store' } },
      );
    }
  },
};
