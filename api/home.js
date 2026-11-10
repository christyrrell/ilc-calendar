import { homeResponse, send, hostOf } from '../lib/handlers.js';

export default async function handler(req, res) {
  send(res, await homeResponse(req.url, hostOf(req)));
}
